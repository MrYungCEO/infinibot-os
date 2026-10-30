"""
InfiniBot Voice Agent - Streaming pipeline.

Flow per user turn:
  Silero VAD → Speaches STT → gateway /api/voice/chat/stream (SSE sentences)
  → Kokoro /v1/audio/speech (PCM stream) → rtc.AudioSource

The agent audio track is published once at startup and reused for every turn, so
there's no publish round-trip per reply. Sentences from the LLM stream TTS in
parallel: sentence N is being synthesized/played while sentence N+1 is still
being generated.
"""

import asyncio
import os
import logging
import pathlib
import uuid
import wave
import io
import json
from typing import Optional
from dotenv import load_dotenv
import aiohttp
from livekit import rtc, api
from livekit.plugins import silero
from livekit.agents.vad import VADEventType

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("infinibot-voice-agent")

# Configuration
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7882")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")
INFINIBOT_GATEWAY_URL = os.getenv("INFINIBOT_GATEWAY_URL", "http://localhost:18789")
INFINIBOT_GATEWAY_TOKEN = os.getenv("INFINIBOT_GATEWAY_TOKEN", "")
SPEACHES_URL = os.getenv("SPEACHES_URL", "http://localhost:8002")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "Systran/faster-whisper-medium")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "en")
KOKORO_URL = os.getenv("KOKORO_URL", "http://localhost:8882")
TTS_VOICE = os.getenv("TTS_VOICE", "coral")
AGENT_NAME = os.getenv("AGENT_NAME", "InfiniBot Assistant")
# LiveKit identity must be unique per room-connection. The supervisor
# (run_agent.py) restarts this process on crash, and LiveKit's server can hold
# the prior identity open for a few seconds — reusing AGENT_NAME causes the new
# instance to be kicked with reason=DuplicateIdentity, which silently kills
# transcription. Suffix a short random id per process so restarts never collide.
AGENT_IDENTITY = os.getenv("AGENT_IDENTITY") or f"{AGENT_NAME}-{uuid.uuid4().hex[:8]}"
ROOM_NAME = os.getenv("ROOM_NAME", "infinibot-room")
SESSION_KEY = os.getenv("VOICE_SESSION_KEY", "agent:main:voice")

# Gateway writes voice-settings.json next to its cwd (repo root). Agent lives in voice-agent/.
VOICE_SETTINGS_FILE = pathlib.Path(__file__).resolve().parent.parent / "voice-settings.json"


def get_current_tts_voice() -> str:
    """Read the UI-selected Kokoro voice from the shared settings file on each call.
    Falls back to the TTS_VOICE env default if the file is missing, unreadable, or the
    active provider isn't Kokoro (in which case we still hand Kokoro a sane voice)."""
    try:
        if VOICE_SETTINGS_FILE.exists():
            with VOICE_SETTINGS_FILE.open("r", encoding="utf-8") as f:
                settings = json.load(f)
            voice = settings.get("tts_voice_kokoro") or settings.get("tts_voice")
            if isinstance(voice, str) and voice.strip():
                return voice.strip()
    except Exception as e:
        logger.warning(f"Failed to read voice settings: {e}")
    return TTS_VOICE


# VAD tuning (Silero)
VAD_MIN_SPEECH_DURATION = float(os.getenv("VAD_MIN_SPEECH_DURATION", "0.2"))
VAD_MIN_SILENCE_DURATION = float(os.getenv("VAD_MIN_SILENCE_DURATION", "0.4"))
VAD_ACTIVATION_THRESHOLD = float(os.getenv("VAD_ACTIVATION_THRESHOLD", "0.5"))
# To interrupt an in-progress agent reply, the user must speak continuously for
# at least this long. Shorter bursts are ignored as likely echo/noise.
INTERRUPT_MIN_SPEECH_DURATION = float(os.getenv("INTERRUPT_MIN_SPEECH_DURATION", "0.6"))
# Max number of recent agent sentences to retain for echo matching.
RECENT_AGENT_WINDOW = 20

# Kokoro output format (hard-coded by the model)
KOKORO_SAMPLE_RATE = 24000
KOKORO_CHANNELS = 1
# 20ms output frames to LiveKit
TTS_FRAME_MS = 20
TTS_SAMPLES_PER_FRAME = KOKORO_SAMPLE_RATE * TTS_FRAME_MS // 1000  # 480
TTS_FRAME_BYTES = TTS_SAMPLES_PER_FRAME * 2  # 16-bit mono


class VoiceAgent:
    def __init__(self):
        self.room: Optional[rtc.Room] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.vad: Optional[silero.VAD] = None
        self.agent_source: Optional[rtc.AudioSource] = None
        self.agent_track_published = False
        self.current_turn_task: Optional[asyncio.Task] = None
        self.is_speaking = False
        # Rolling window of what the agent has recently said. Used to reject
        # mic input that's just speaker echo of the agent's own TTS.
        self.recent_agent_sentences: list[str] = []
        # Active VAD pipeline tasks, keyed by participant identity. LiveKit
        # doesn't always cleanly end AudioStream iterators on unsubscribe, so
        # if we spawn a new pipeline per subscribe without cancelling the old
        # one we end up with multiple concurrent VAD streams on the same user
        # firing duplicate transcriptions. Cancel-on-replace keeps it to one.
        self._vad_tasks: dict[str, asyncio.Task] = {}

    async def start(self):
        logger.info(
            f"Starting {AGENT_NAME} (identity={AGENT_IDENTITY}) — "
            f"STT={WHISPER_MODEL}(lang={WHISPER_LANGUAGE}) TTS=Kokoro"
        )

        self.session = aiohttp.ClientSession()
        self.vad = silero.VAD.load(
            min_speech_duration=VAD_MIN_SPEECH_DURATION,
            min_silence_duration=VAD_MIN_SILENCE_DURATION,
            activation_threshold=VAD_ACTIVATION_THRESHOLD,
        )
        token = await self.generate_token()
        self.room = rtc.Room()

        self.room.on("participant_connected", self.on_participant_connected)
        self.room.on("track_subscribed", self.on_track_subscribed)
        self.room.on("track_unsubscribed", self.on_track_unsubscribed)

        logger.info(f"Connecting to room: {ROOM_NAME}")
        await self.room.connect(LIVEKIT_URL, token)
        logger.info("Connected to LiveKit room!")

        await self._publish_agent_track()

        try:
            await asyncio.sleep(float('inf'))
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            await self.cleanup()

    async def _publish_agent_track(self):
        """Publish the agent's persistent audio track. Reused for every reply."""
        self.agent_source = rtc.AudioSource(KOKORO_SAMPLE_RATE, KOKORO_CHANNELS)
        track = rtc.LocalAudioTrack.create_audio_track("agent-voice", self.agent_source)
        options = rtc.TrackPublishOptions()
        options.source = rtc.TrackSource.SOURCE_MICROPHONE
        await self.room.local_participant.publish_track(track, options)
        self.agent_track_published = True
        logger.info(f"[Audio] Agent track published ({KOKORO_SAMPLE_RATE}Hz mono, persistent)")

    async def generate_token(self) -> str:
        token = api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        # Identity is per-process-unique (see AGENT_IDENTITY above); name stays
        # stable so the UI shows a consistent label.
        token.with_identity(AGENT_IDENTITY)
        token.with_name(AGENT_NAME)
        token.with_grants(api.VideoGrants(
            room_join=True, room=ROOM_NAME, can_publish=True, can_subscribe=True
        ))
        return token.to_jwt()

    def on_participant_connected(self, participant: rtc.RemoteParticipant):
        logger.info(f"Participant connected: {participant.identity}")

    def on_track_subscribed(self, track: rtc.Track, publication, participant):
        logger.info(f"Track subscribed: {track.kind} from {participant.identity}")

        # Own track (by unique identity) or anything that looks like another
        # agent in the room — don't loop back through STT.
        if participant.identity == AGENT_IDENTITY:
            logger.info(f"Ignoring own track from {participant.identity}")
            return
        if (
            participant.identity.startswith("agent-")
            or participant.identity.startswith("Infini")
            or participant.identity.startswith(AGENT_NAME)
        ):
            logger.info(f"Ignoring agent track from {participant.identity}")
            return

        if track.kind == rtc.TrackKind.KIND_AUDIO:
            logger.info(f"Processing audio from USER: {participant.identity}")
            # Cancel any leftover pipeline for this identity before starting a
            # new one. LiveKit can re-fire `track_subscribed` after reconnect
            # without reliably terminating the prior AudioStream iterator.
            self._cancel_vad_task(participant.identity, reason="resubscribe")
            task = asyncio.create_task(self.process_audio_track(track, participant))
            self._vad_tasks[participant.identity] = task
            task.add_done_callback(
                lambda t, ident=participant.identity: self._vad_tasks.pop(ident, None)
                if self._vad_tasks.get(ident) is t
                else None
            )

    def on_track_unsubscribed(self, track, publication, participant):
        logger.info(f"Track unsubscribed: {track.kind} from {participant.identity}")
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            self._cancel_vad_task(participant.identity, reason="unsubscribe")

    def _cancel_vad_task(self, identity: str, reason: str) -> None:
        existing = self._vad_tasks.pop(identity, None)
        if existing and not existing.done():
            logger.info(f"[VAD] Cancelling prior pipeline for {identity} ({reason})")
            existing.cancel()

    # ──────────────────────────────────────────────────────────────────
    # Audio capture: Silero VAD drives turn detection.
    # ──────────────────────────────────────────────────────────────────

    async def process_audio_track(self, track: rtc.AudioTrack, participant: rtc.RemoteParticipant):
        logger.info(f"Starting Silero VAD pipeline for {participant.identity}")

        audio_stream = rtc.AudioStream(track)
        vad_stream = self.vad.stream()

        async def feed_vad():
            try:
                async for event in audio_stream:
                    vad_stream.push_frame(event.frame)
            finally:
                vad_stream.end_input()

        feed_task = asyncio.create_task(feed_vad())

        try:
            async for ev in vad_stream:
                if ev.type == VADEventType.START_OF_SPEECH:
                    logger.info(
                        f"[VAD] Speech started (agent_speaking={self.is_speaking})"
                    )
                elif ev.type == VADEventType.END_OF_SPEECH:
                    logger.info(
                        f"[VAD] Speech ended "
                        f"(duration={ev.speech_duration:.2f}s, "
                        f"frames={len(ev.frames)}, "
                        f"agent_speaking={self.is_speaking})"
                    )
                    if not ev.frames:
                        continue
                    frames = list(ev.frames)

                    if self.is_speaking:
                        # Candidate interruption. Require a minimum duration so
                        # short bursts of echo/noise don't even reach STT, then
                        # let handle_utterance validate the content before it
                        # actually cancels the agent.
                        if ev.speech_duration < INTERRUPT_MIN_SPEECH_DURATION:
                            logger.info(
                                f"[Interrupt] Ignored — too short "
                                f"({ev.speech_duration:.2f}s < "
                                f"{INTERRUPT_MIN_SPEECH_DURATION}s)"
                            )
                            continue
                        asyncio.create_task(
                            self.handle_utterance(frames, is_interrupt_candidate=True)
                        )
                    else:
                        if ev.speech_duration < VAD_MIN_SPEECH_DURATION:
                            continue
                        self.current_turn_task = asyncio.create_task(
                            self.handle_utterance(frames, is_interrupt_candidate=False)
                        )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"[VAD] Error: {e}", exc_info=True)
        finally:
            feed_task.cancel()
            try:
                await feed_task
            except (asyncio.CancelledError, Exception):
                pass
            await vad_stream.aclose()
            logger.info(f"[VAD] Pipeline ended for {participant.identity}")

    async def _interrupt_agent_if_speaking(self):
        """If the agent is mid-reply, cancel the turn and flush queued audio."""
        if self.current_turn_task and not self.current_turn_task.done():
            logger.info("[Barge-in] Cancelling current agent reply")
            self.current_turn_task.cancel()
            try:
                await self.current_turn_task
            except (asyncio.CancelledError, Exception):
                pass
        if self.is_speaking and self.agent_source is not None:
            try:
                self.agent_source.clear_queue()
            except Exception as e:
                logger.warning(f"[Barge-in] clear_queue failed: {e}")
        self.is_speaking = False

    # ──────────────────────────────────────────────────────────────────
    # Turn handling: STT → streaming LLM → streaming TTS.
    # ──────────────────────────────────────────────────────────────────

    async def handle_utterance(
        self,
        frames: list[rtc.AudioFrame],
        is_interrupt_candidate: bool = False,
    ):
        try:
            # 1. Concatenate frames and transcribe at the frame's native rate
            sample_rate = frames[0].sample_rate
            audio_bytes = b"".join(bytes(f.data) for f in frames)

            logger.info(f"[Transcribe] {len(audio_bytes)} bytes @ {sample_rate}Hz")
            text = await self.transcribe(audio_bytes, sample_rate)
            if not text:
                logger.info("[Transcribe] Empty result")
                return

            cleaned = self.clean_transcription(text)
            if not cleaned:
                logger.info("[Transcribe] Cleaned to empty, skipping")
                return

            # Echo guard: always reject transcripts that substantially overlap
            # with what the agent has recently said. Two leak paths made this
            # necessary: (1) interrupt-candidate where is_speaking flipped to
            # False before STT returned (was downgraded to "normal turn" and
            # skipped the check), and (2) END_OF_SPEECH that fires after
            # playout finishes due to speaker→mic propagation lag (lands on
            # the non-interrupt branch entirely). Both fed TTS output back in
            # as user input → self-loop.
            if self._is_echo_of_recent_agent(cleaned):
                logger.info(
                    f"[Echo] Rejected: '{cleaned}' "
                    f"(interrupt={is_interrupt_candidate}, "
                    f"agent_speaking={self.is_speaking})"
                )
                return

            if is_interrupt_candidate:
                if not self.is_speaking:
                    # Agent finished by the time STT returned; treat as normal turn.
                    is_interrupt_candidate = False
                else:
                    logger.info(f"[Interrupt] Accepted: '{cleaned}'")
                    await self._interrupt_agent_if_speaking()

            logger.info(f"[User] {cleaned}")
            await self.publish_chat("user", cleaned)

            # 2. Stream LLM response → TTS → audio
            await self.stream_response(cleaned)
        except asyncio.CancelledError:
            logger.info("[Turn] Cancelled (likely barge-in)")
            raise
        except Exception as e:
            logger.error(f"[Turn] Error: {e}", exc_info=True)

    def _is_echo_of_recent_agent(self, text: str) -> bool:
        """Return True if `text` looks like a (partial) echo of the agent's own
        recent output. Uses substring and word-overlap heuristics — imperfect
        but catches the common case where speaker audio bleeds into the mic."""
        text_low = text.lower().strip()
        if not text_low:
            return True
        text_words = set(w for w in text_low.split() if len(w) > 2)
        if not text_words:
            # Too few content words to reliably judge — treat as echo to be safe.
            return True
        for recent in self.recent_agent_sentences:
            recent_low = recent.lower().strip()
            if not recent_low:
                continue
            # Exact containment either direction
            if text_low in recent_low or recent_low in text_low:
                return True
            # Word overlap: if ≥60% of the candidate's content words appear in
            # a recent agent sentence, call it echo.
            recent_words = set(w for w in recent_low.split() if len(w) > 2)
            if not recent_words:
                continue
            overlap = len(text_words & recent_words) / len(text_words)
            if overlap >= 0.6:
                return True
        return False

    def _remember_agent_sentence(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        self.recent_agent_sentences.append(text)
        # Trim the oldest entries when we exceed the rolling window
        if len(self.recent_agent_sentences) > RECENT_AGENT_WINDOW:
            del self.recent_agent_sentences[: len(self.recent_agent_sentences) - RECENT_AGENT_WINDOW]

    async def transcribe(self, audio_data: bytes, sample_rate: int) -> str:
        try:
            wav_buffer = io.BytesIO()
            with wave.open(wav_buffer, 'wb') as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(audio_data)
            wav_buffer.seek(0)

            form_data = aiohttp.FormData()
            form_data.add_field('file', wav_buffer, filename='audio.wav', content_type='audio/wav')
            form_data.add_field('model', WHISPER_MODEL)
            # Lock to English (FasterWhisper's auto-detect is biased on short clips)
            form_data.add_field('language', WHISPER_LANGUAGE)
            form_data.add_field('temperature', '0.0')

            async with self.session.post(
                f"{SPEACHES_URL}/v1/audio/transcriptions",
                data=form_data,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                if response.status != 200:
                    logger.error(f"[Transcribe] {response.status}: {await response.text()}")
                    return ""
                data = await response.json()
                text = (data.get("text") or "").strip()
                logger.info(f"[Transcribe] '{text}'")
                return text
        except Exception as e:
            logger.error(f"[Transcribe] Failed: {e}", exc_info=True)
            return ""

    def clean_transcription(self, text: str) -> str:
        """Remove common Whisper hallucinations and artifacts."""
        if not text:
            return ""

        artifacts = [
            "thanks for watching",
            "thank you for watching",
            "please subscribe",
            "like and subscribe",
            "see you next time",
            "goodbye",
            "bye bye",
            "bye-bye",
            "[music]",
            "[applause]",
            "[laughter]",
            "(music)",
            "(applause)",
        ]

        result = text.lower().strip()

        for artifact in artifacts:
            if result == artifact or result.replace(".", "").replace(",", "").strip() == artifact:
                logger.info(f"[STT] Artifact filtered: '{text}'")
                return ""

        for artifact in artifacts:
            result = result.replace(artifact, "")

        result = result.strip()
        if len(result) < 3:
            logger.info(f"[STT] Too short after cleanup: '{text}' -> '{result}'")
            return ""

        return text.strip()

    async def publish_chat(self, role: str, message: str):
        """Publish chat message to UI via LiveKit data channel."""
        try:
            payload = json.dumps({
                "type": "transcript",
                "role": role,
                "text": message,
                "message": message,  # Also include 'message' for compatibility
            }).encode("utf-8")
            await self.room.local_participant.publish_data(payload, topic="lk-chat-topic", reliable=True)
            logger.info(f"[Chat] Published {role}: {message[:50]}...")
        except Exception as e:
            logger.error(f"[Chat] publish error: {e}")

    # ──────────────────────────────────────────────────────────────────
    # Streaming LLM + TTS pipeline.
    # ──────────────────────────────────────────────────────────────────

    async def stream_response(self, user_text: str):
        """Request SSE from the gateway; feed sentences into an ordered TTS queue.

        A single TTS worker consumes sentences serially so audio plays out in order
        and we never overlap Kokoro calls on the same audio source.
        """
        sentence_queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        collected: list[str] = []
        self.is_speaking = True

        async def sse_producer():
            headers = {
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            }
            if INFINIBOT_GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {INFINIBOT_GATEWAY_TOKEN}"

            payload = {"message": user_text, "sessionKey": SESSION_KEY}
            try:
                async with self.session.post(
                    f"{INFINIBOT_GATEWAY_URL}/api/voice/chat/stream",
                    json=payload,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.error(f"[Stream] gateway {resp.status}: {body[:200]}")
                        return
                    async for raw_line in resp.content:
                        line = raw_line.strip()
                        if not line or not line.startswith(b"data: "):
                            continue
                        data = line[6:]
                        if data == b"[DONE]":
                            return
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        if chunk.get("error"):
                            logger.warning(f"[Stream] error: {chunk['error']}")
                            continue
                        text = (chunk.get("text") or "").strip()
                        if not text:
                            continue
                        collected.append(text)
                        self._remember_agent_sentence(text)
                        # Publish the transcript sentence immediately so the UI
                        # updates in real time instead of waiting for playout.
                        asyncio.create_task(self.publish_chat("agent", text))
                        await sentence_queue.put(text)
            finally:
                await sentence_queue.put(None)  # sentinel

        async def tts_consumer():
            while True:
                sentence = await sentence_queue.get()
                if sentence is None:
                    return
                await self.synthesize_and_play(sentence)

        producer = asyncio.create_task(sse_producer())
        consumer = asyncio.create_task(tts_consumer())

        try:
            await asyncio.gather(producer, consumer)
        except asyncio.CancelledError:
            producer.cancel()
            consumer.cancel()
            raise
        finally:
            # Wait for queued TTS frames to actually finish playing before we
            # drop the is_speaking guard — otherwise the mic opens up while
            # the last second of agent audio is still coming out the speakers.
            if self.agent_source is not None:
                try:
                    await asyncio.wait_for(self.agent_source.wait_for_playout(), timeout=30)
                except (asyncio.TimeoutError, Exception):
                    pass
            self.is_speaking = False

    async def synthesize_and_play(self, text: str):
        """Stream PCM from Kokoro directly into the persistent agent audio source."""
        voice = get_current_tts_voice()
        logger.info(f"[TTS] '{voice}' ← {text[:60]}...")

        payload = {
            "model": "kokoro",
            "voice": voice,
            "input": text[:1000],
            "response_format": "pcm",
            "stream": True,
        }

        try:
            async with self.session.post(
                f"{KOKORO_URL}/v1/audio/speech",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.error(f"[TTS] {resp.status}: {body[:200]}")
                    return
                buffer = bytearray()
                async for chunk in resp.content.iter_chunked(4096):
                    if not chunk:
                        continue
                    buffer.extend(chunk)
                    while len(buffer) >= TTS_FRAME_BYTES:
                        frame_bytes = bytes(buffer[:TTS_FRAME_BYTES])
                        del buffer[:TTS_FRAME_BYTES]
                        frame = rtc.AudioFrame(
                            data=frame_bytes,
                            sample_rate=KOKORO_SAMPLE_RATE,
                            num_channels=KOKORO_CHANNELS,
                            samples_per_channel=TTS_SAMPLES_PER_FRAME,
                        )
                        await self.agent_source.capture_frame(frame)
                # Flush tail, padded to frame boundary
                if buffer:
                    pad = TTS_FRAME_BYTES - len(buffer)
                    if pad > 0:
                        buffer.extend(b"\x00" * pad)
                    frame = rtc.AudioFrame(
                        data=bytes(buffer),
                        sample_rate=KOKORO_SAMPLE_RATE,
                        num_channels=KOKORO_CHANNELS,
                        samples_per_channel=TTS_SAMPLES_PER_FRAME,
                    )
                    await self.agent_source.capture_frame(frame)
        except asyncio.CancelledError:
            # Barge-in: flush queued PCM so the user isn't talking over stale audio
            if self.agent_source is not None:
                try:
                    self.agent_source.clear_queue()
                except Exception:
                    pass
            raise
        except Exception as e:
            logger.error(f"[TTS] Failed: {e}", exc_info=True)

    async def cleanup(self):
        if self.current_turn_task and not self.current_turn_task.done():
            self.current_turn_task.cancel()
        if self.agent_source is not None:
            try:
                await self.agent_source.aclose()
            except Exception:
                pass
        if self.room:
            await self.room.disconnect()
        if self.session:
            await self.session.close()


if __name__ == "__main__":
    asyncio.run(VoiceAgent().start())
