"""
InfiniBot Voice Agent - Routes voice through InfiniBot Gateway
Optimized for streaming TTS + async task dispatch
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from typing import AsyncIterator
from urllib.parse import urlparse, urlunparse

import aiohttp
from dotenv import load_dotenv

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AgentServer,
    JobContext,
    JobProcess,
    RoomInputOptions,
    cli,
)
from livekit.agents import llm
from livekit.agents.llm import ChatChunk, ChatContext, ChoiceDelta
from livekit.agents.llm.tool_context import FunctionTool, RawFunctionTool
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, APIConnectOptions, NotGivenOr
from livekit.agents import tts as lk_tts
from livekit.plugins import silero
from tts_sanitize import sanitize_for_tts

load_dotenv()


# ---------------------------------------------------------------------------
# KokoroTTS — direct HTTP TTS that bypasses livekit-plugins-openai.
#
# Why: the openai plugin's streaming TTS path was rebuilt around OpenAI's new
# `gpt-4o-mini-tts` flow — it hardcodes `stream_format="audio"`, `instructions=...`,
# and tags chunks with mime types like `audio/mp3` (vs. the standard
# `audio/mpeg`). Kokoro doesn't speak that dialect well; the result was the
# plugin opening the stream, getting bytes back, and then quietly producing
# zero `AudioFrame`s — surfacing as `APIError: no audio frames were pushed`.
#
# This adapter speaks the OpenAI-compat /v1/audio/speech endpoint directly,
# requests raw 24 kHz mono PCM (which matches Kokoro's native rate, no
# decoding needed), and pushes bytes into the AudioEmitter with mime
# "audio/pcm" — the exact branch in tts.py that handles raw PCM.
# ---------------------------------------------------------------------------
class _KokoroChunkedStream(lk_tts.ChunkedStream):
    def __init__(self, *, tts: "KokoroTTS", input_text: str, conn_options: APIConnectOptions):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._kokoro_tts = tts

    async def _run(self, output_emitter: lk_tts.AudioEmitter) -> None:
        request_id = uuid.uuid4().hex
        output_emitter.initialize(
            request_id=request_id,
            sample_rate=self._kokoro_tts.sample_rate,
            num_channels=self._kokoro_tts.num_channels,
            mime_type="audio/pcm",
        )
        payload = {
            "model": self._kokoro_tts._model,
            "voice": self._kokoro_tts._voice,
            "input": self._input_text,
            "response_format": "pcm",
        }
        timeout = aiohttp.ClientTimeout(total=30, connect=self._conn_options.timeout)
        last_error: Exception | None = None
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for base_url in self._kokoro_tts._base_urls:
                url = f"{base_url.rstrip('/')}/audio/speech"
                try:
                    logger.info(
                        f"[TTS] {self._kokoro_tts._voice!r} via {base_url} ← "
                        f"{self._input_text[:60]}..."
                    )
                    async with session.post(url, json=payload) as resp:
                        if resp.status >= 400:
                            body = await resp.text()
                            # A 404/405 usually means we hit the wrong
                            # OpenAI-compatible base URL. Try the next known
                            # endpoint before falling back to silence.
                            if resp.status in (404, 405):
                                last_error = RuntimeError(f"kokoro TTS {resp.status}: {body[:200]}")
                                continue
                            raise RuntimeError(f"kokoro TTS {resp.status}: {body[:200]}")
                        async for chunk in resp.content.iter_chunked(4096):
                            if chunk:
                                output_emitter.push(chunk)
                    output_emitter.flush()
                    return
                except (aiohttp.ClientConnectorError, aiohttp.ServerDisconnectedError, asyncio.TimeoutError) as e:
                    last_error = e
                    logger.warning(f"Kokoro TTS endpoint failed ({base_url}): {e}")
                    continue

        # Kokoro unreachable / sluggish (its FastAPI server periodically
        # never finishes booting — see docker-compose comment on the
        # `kokoro` service). Emit ~80ms of silence so the LiveKit Agents
        # pipeline still treats this speech turn as committed; without
        # at least one frame `tts.py` raises "no audio frames were pushed"
        # and the upstream session aborts before it can fire
        # `agent_speech_committed` — which is the only path that
        # publishes the assistant transcript back to the room.
        logger.warning(
            f"Kokoro TTS unreachable after trying {self._kokoro_tts._base_urls}; "
            f"falling back to silent audio so the transcript still reaches the room: {last_error}"
        )
        silence_samples = int(self._kokoro_tts.sample_rate * 0.08)
        silence_bytes = b"\x00\x00" * silence_samples * self._kokoro_tts.num_channels
        output_emitter.push(silence_bytes)
        output_emitter.flush()


class _SilenceStream(lk_tts.ChunkedStream):
    """Emits ~80 ms of silence without calling Kokoro; used when sanitized TTS input is empty."""

    def __init__(self, *, tts: "KokoroTTS", conn_options: APIConnectOptions):
        super().__init__(tts=tts, input_text="", conn_options=conn_options)
        self._kokoro_tts = tts

    async def _run(self, output_emitter: lk_tts.AudioEmitter) -> None:
        request_id = uuid.uuid4().hex
        output_emitter.initialize(
            request_id=request_id,
            sample_rate=self._kokoro_tts.sample_rate,
            num_channels=self._kokoro_tts.num_channels,
            mime_type="audio/pcm",
        )
        silence_samples = int(self._kokoro_tts.sample_rate * 0.08)
        silence_bytes = b"\x00\x00" * silence_samples * self._kokoro_tts.num_channels
        output_emitter.push(silence_bytes)
        output_emitter.flush()


class KokoroTTS(lk_tts.TTS):
    """OpenAI-compat /v1/audio/speech client for Kokoro-FastAPI. 24 kHz mono PCM."""

    def __init__(
        self,
        *,
        base_urls: list[str],
        model: str = "kokoro",
        voice: str = "af_nova",
    ) -> None:
        super().__init__(
            capabilities=lk_tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        self._base_urls = base_urls
        self._model = model
        self._voice = voice

    @property
    def model(self) -> str:
        return self._model

    @property
    def provider(self) -> str:
        return "kokoro"

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> lk_tts.ChunkedStream:
        sanitized = sanitize_for_tts(text)
        if not sanitized:
            logger.info("TTS sanitize: empty after sanitization, emitting silence")
            return _SilenceStream(tts=self, conn_options=conn_options)
        before, after = len(text), len(sanitized)
        if after < before * 0.6:
            logger.info(
                f"TTS sanitize: {before}→{after} chars "
                f"({100*(before-after)//max(before,1):.0f}% stripped)"
            )
        return _KokoroChunkedStream(tts=self, input_text=sanitized, conn_options=conn_options)

# Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("infinibot-voice-agent")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("livekit").setLevel(logging.WARNING)

# Configuration
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://infinibot-livekit:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")
INFINIBOT_GATEWAY_URL = os.getenv("INFINIBOT_GATEWAY_URL", "http://host.docker.internal:47913")
INFINIBOT_GATEWAY_TOKEN = os.getenv("INFINIBOT_GATEWAY_TOKEN", "")
DEFAULT_KOKORO_URL = "http://infinibot-kokoro:8880"
TTS_VOICE = os.getenv("TTS_VOICE", "nova")
AGENT_NAME = os.getenv("AGENT_NAME", "Infini")
# Session key the gateway routes voice messages through. Must reference a
# real agent id from infinibot.json (e.g. "coder", "webdev"). The previous
# default `agent:main:default` referenced agent id "main" which doesn't
# exist in most setups — the gateway then routed to a stub and returned
# `{"response":""}`, presenting as "no responses." `agent:coder:main`
# shares the conversation with the UI's main chat for that agent.
# Default to the `main` agent rather than `coder`. The coder agent loads 17+
# skills into its system prompt — that bloated payload is what was making
# ollama-cloud/kimi-k2.5 return HTTP 500 on every voice request (same model
# was succeeding for the lean `main` agent's grid sessions).
#
# Per-instance sessionKey: when a JobContext fires the entrypoint, we now
# derive `agent:voice:<room.name>` per InfiniBotLLM instance (see below).
# That gives each browser tab — which uses a unique room — its own chat
# history and its own concurrent claude_coder runs. SESSION_KEY here is
# the fallback when no room is available (manual unit-test runs).
SESSION_KEY = os.getenv("SESSION_KEY", "agent:main:voice")
# How long voice-→-gateway HTTP requests are allowed to take before we
# bail. Default 5 minutes so a slow LLM turn doesn't sever the call.
VOICE_CALL_TIMEOUT_SECONDS = int(os.getenv("VOICE_CALL_TIMEOUT_SECONDS", "300"))


def normalize_kokoro_base_url(raw_url: str) -> str:
    base = (raw_url or DEFAULT_KOKORO_URL).strip().rstrip("/")
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return base


def replace_url_port(raw_url: str, port: int) -> str:
    parsed = urlparse(raw_url)
    if not parsed.scheme or not parsed.hostname:
        return raw_url
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{port}"
    if parsed.username:
        auth = parsed.username
        if parsed.password:
            auth = f"{auth}:{parsed.password}"
        netloc = f"{auth}@{netloc}"
    return urlunparse(parsed._replace(netloc=netloc))


def resolve_kokoro_base_urls(raw_url: str | None) -> list[str]:
    """Return ordered /v1 Kokoro base URLs, tolerating stale :8000 configs."""
    primary = normalize_kokoro_base_url(raw_url or DEFAULT_KOKORO_URL)
    candidates = [primary]

    parsed = urlparse(primary)
    if parsed.hostname == "infinibot-kokoro" and parsed.port == 8000:
        candidates.append(normalize_kokoro_base_url(replace_url_port(primary, 8880)))

    # Safe Docker/host fallbacks. These keep old containers audible after
    # kokoro-fastapi-cpu moved its internal port from 8000 to 8880.
    candidates.append(normalize_kokoro_base_url(DEFAULT_KOKORO_URL))
    candidates.append(normalize_kokoro_base_url("http://host.docker.internal:8882"))

    seen: set[str] = set()
    deduped: list[str] = []
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        deduped.append(candidate)
    return deduped

# Task classification keywords for async dispatch
TASK_KEYWORDS = [
    "build", "create", "make", "develop", "implement", "code", "write",
    "research", "analyze", "investigate", "find", "search",
    "update", "fix", "debug", "refactor", "optimize",
    "deploy", "setup", "configure", "install",
]

# Quick acknowledgment phrases
QUICK_ACKS = [
    "On it. I'll let you know when it's done.",
    "Got it, working on that now. I'll ping you when ready.",
    "Starting on that. Will update you when complete.",
    "Alright, handling that in the background. You'll hear from me when it's finished.",
]


def is_background_task(text: str) -> bool:
    """Detect if message is a background task request."""
    text_lower = text.lower()
    # Check for task keywords
    for keyword in TASK_KEYWORDS:
        if keyword in text_lower:
            # Also check it's a request (not a question about)
            if any(q in text_lower for q in ["can you", "please", "could you", "i need", "i want", "let's"]):
                return True
    return False


def split_into_sentences(text: str) -> list[str]:
    """Split text into sentences for streaming TTS."""
    # Match sentence endings, keeping the punctuation
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    # Filter empty and clean up
    return [s.strip() for s in sentences if s.strip()]


class InfiniBotLLM(llm.LLM):
    """LLM that routes through InfiniBot gateway with streaming support."""

    def __init__(self, room_name: str = "") -> None:
        super().__init__()
        self._http: aiohttp.ClientSession | None = None
        self._room_name = room_name
        # Per-room sessionKey isolates concurrent browser tabs from each other.
        # Empty room_name (e.g. ad-hoc invocations) falls back to the module
        # default. Room names are namespaced "voice-<uuid>" by the UI so
        # collisions across tabs are impossible.
        self._session_key = f"agent:voice:{room_name}" if room_name else SESSION_KEY
        logger.info(
            f"InfiniBotLLM initialized - Gateway: {INFINIBOT_GATEWAY_URL}, "
            f"sessionKey: {self._session_key}"
        )

    async def _ensure_http(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=False))
        return self._http

    async def call_gateway(self, text: str) -> str:
        """Call InfiniBot gateway and return response."""
        try:
            http = await self._ensure_http()
            headers = {"Content-Type": "application/json"}
            if INFINIBOT_GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {INFINIBOT_GATEWAY_TOKEN}"

            logger.info(f"[Voice→Gateway] '{text[:80]}...'")

            async with http.post(
                f"{INFINIBOT_GATEWAY_URL}/api/voice/chat",
                json={"message": text, "sessionKey": self._session_key},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=VOICE_CALL_TIMEOUT_SECONDS),
            ) as resp:
                if resp.status != 200:
                    logger.error(f"Gateway error {resp.status}: {await resp.text()}")
                    return "I'm having trouble connecting."
                data = await resp.json()
                result = data.get("response", "I didn't catch that.")
                logger.info(f"[Gateway→Voice] '{result[:80]}...'")
                return result
        except Exception as e:
            logger.error(f"Gateway call failed: {e}")
            return "Connection issue. One moment."

    async def stream_gateway(self, text: str) -> AsyncIterator[str]:
        """Stream the agent's reply via the gateway's true SSE endpoint.

        The gateway's `/api/voice/chat/stream` writes
            data: {"text": "...", "index": N}\\n\\n
        events as the LLM emits tokens (chunked at phrase/sentence
        boundaries), then `data: [DONE]\\n\\n` at the end. The endpoint also
        adds a "voice preamble" that instructs the model to narrate every
        tool call ("Let me check that…") and reply in short conversational
        sentences — that's the main mechanism that removes long silences
        during tool-use chains.

        Critically: we iterate `resp.content` chunk-by-chunk instead of
        `await resp.text()`. The previous implementation buffered the
        whole stream before parsing, which defeated streaming entirely
        and caused the "unnatural gaps" the user reported.
        """
        try:
            http = await self._ensure_http()
            headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
            if INFINIBOT_GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {INFINIBOT_GATEWAY_TOKEN}"

            logger.info(f"[Voice→Gateway Stream] '{text[:80]}...'")

            async with http.post(
                f"{INFINIBOT_GATEWAY_URL}/api/voice/chat/stream",
                json={"message": text, "sessionKey": self._session_key},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=VOICE_CALL_TIMEOUT_SECONDS),
            ) as resp:
                if resp.status != 200:
                    error = await resp.text()
                    logger.error(f"Gateway stream error {resp.status}: {error[:200]}")
                    yield "I'm having trouble connecting."
                    return

                # Read SSE bytes as they arrive. Accumulate into `pending`
                # and split on the SSE event delimiter (`\n\n`) so we
                # process complete events only.
                pending = b""
                async for piece in resp.content.iter_any():
                    if not piece:
                        continue
                    pending += piece
                    while b"\n\n" in pending:
                        raw_event, pending = pending.split(b"\n\n", 1)
                        for raw_line in raw_event.split(b"\n"):
                            line = raw_line.decode("utf-8", errors="ignore").strip()
                            if not line.startswith("data: "):
                                continue
                            payload = line[len("data: "):]
                            if payload == "[DONE]":
                                return
                            try:
                                ev = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            # The stream endpoint sometimes includes an
                            # `error` field — surface it so it gets spoken
                            # (matches the gateway-side error-surface fix).
                            err = ev.get("error")
                            if err:
                                logger.warning(f"[Stream Error] {err}")
                                yield f"Backend error: {str(err)[:80]}"
                                continue
                            chunk_text = ev.get("text", "")
                            if chunk_text:
                                # Yield as-is. The stream endpoint already
                                # chunked at phrase/sentence boundaries —
                                # don't re-split or we lose the natural
                                # pacing the upstream worked to produce.
                                yield chunk_text

        except Exception as e:
            logger.error(f"Gateway stream failed: {e}")
            yield "Connection issue."

    async def stream_gateway_events(self, text: str):
        """Stream ('runid', id) then ('text', chunk) tuples from the gateway SSE.

        Same endpoint/transport as `stream_gateway()` (POST
        `/api/voice/chat/stream`), but ALSO surfaces the leading `runId` event
        the gateway now emits first, so the caller can cancel this exact run on
        barge-in. Kept as a separate method so the legacy `InfiniBotLLMStream`
        fallback path (which calls `stream_gateway()`) stays byte-for-byte
        unchanged and the web-voice / text-chat paths are untouched.
        """
        try:
            http = await self._ensure_http()
            headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
            if INFINIBOT_GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {INFINIBOT_GATEWAY_TOKEN}"

            logger.info(f"[Voice→Gateway Stream] '{text[:80]}...'")

            async with http.post(
                f"{INFINIBOT_GATEWAY_URL}/api/voice/chat/stream",
                json={"message": text, "sessionKey": self._session_key},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=VOICE_CALL_TIMEOUT_SECONDS),
            ) as resp:
                if resp.status != 200:
                    error = await resp.text()
                    logger.error(f"Gateway stream error {resp.status}: {error[:200]}")
                    yield ("text", "I'm having trouble connecting.")
                    return

                pending = b""
                async for piece in resp.content.iter_any():
                    if not piece:
                        continue
                    pending += piece
                    while b"\n\n" in pending:
                        raw_event, pending = pending.split(b"\n\n", 1)
                        for raw_line in raw_event.split(b"\n"):
                            line = raw_line.decode("utf-8", errors="ignore").strip()
                            if not line.startswith("data: "):
                                continue
                            payload = line[len("data: "):]
                            if payload == "[DONE]":
                                return
                            try:
                                ev = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            # First event carries the gateway runId — surface it
                            # so the agent can cancel this run on barge-in.
                            run_id = ev.get("runId")
                            if run_id:
                                yield ("runid", run_id)
                                continue
                            err = ev.get("error")
                            if err:
                                logger.warning(f"[Stream Error] {err}")
                                yield ("text", f"Backend error: {str(err)[:80]}")
                                continue
                            chunk_text = ev.get("text", "")
                            if chunk_text:
                                yield ("text", chunk_text)
        except Exception as e:
            logger.error(f"Gateway stream failed: {e}")
            yield ("text", "Connection issue.")

    async def cancel_run(self, run_id: str) -> None:
        """Ask the gateway to abort the in-flight voice run keyed by `run_id`.

        Called on barge-in so a superseded reply stops being GENERATED on the
        backend (not just muted locally). Fire-and-forget; failures are logged
        but never surfaced to the caller.
        """
        if not run_id:
            return
        try:
            http = await self._ensure_http()
            headers = {"Content-Type": "application/json"}
            if INFINIBOT_GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {INFINIBOT_GATEWAY_TOKEN}"
            async with http.post(
                f"{INFINIBOT_GATEWAY_URL}/api/voice/chat/cancel",
                json={"runId": run_id},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                body = await resp.text()
                logger.info(f"[Barge-in] cancel runId={run_id} → {resp.status} {body[:80]}")
        except Exception as e:
            logger.warning(f"[Barge-in] cancel failed for {run_id}: {e}")

    async def spawn_background_task(self, task: str) -> dict:
        """Spawn a background task via gateway."""
        try:
            http = await self._ensure_http()
            headers = {"Content-Type": "application/json"}
            if INFINIBOT_GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {INFINIBOT_GATEWAY_TOKEN}"

            logger.info(f"[Voice→Spawn] '{task[:80]}...'")

            async with http.post(
                f"{INFINIBOT_GATEWAY_URL}/api/voice/spawn",
                json={
                    "task": task,
                    "voiceRoom": self._room_name,
                    "label": f"🎤 {task[:40]}",
                },
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    logger.error(f"Spawn error {resp.status}: {await resp.text()}")
                    return {"ok": False, "error": "Failed to spawn task"}
                return await resp.json()
        except Exception as e:
            logger.error(f"Spawn failed: {e}")
            return {"ok": False, "error": str(e)}

    @property
    def model(self) -> str:
        return "infinibot-gateway"

    @property
    def provider(self) -> str:
        return "infinibot"

    def chat(
        self,
        *,
        chat_ctx: ChatContext,
        tools: list[FunctionTool | RawFunctionTool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict] = NOT_GIVEN,
    ) -> llm.LLMStream:
        """Create LLM stream for chat completion."""
        stream = InfiniBotLLMStream(
            llm=self,
            chat_ctx=chat_ctx,
            tools=tools or [],
            conn_options=conn_options,
        )
        return stream

    async def aclose(self) -> None:
        if self._http and not self._http.closed:
            await self._http.close()


class InfiniBotLLMStream(llm.LLMStream):
    """LLM stream with sentence-based streaming for faster TTS."""

    def __init__(
        self,
        llm: InfiniBotLLM,
        *,
        chat_ctx: ChatContext,
        tools: list[FunctionTool | RawFunctionTool],
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._infinibot_llm = llm
        self._chat_ctx = chat_ctx

    def _extract_user_message(self) -> str:
        """Extract the last user message from context."""
        messages = list(self._chat_ctx.messages())
        for msg in reversed(messages):
            if msg.role == "user":
                if isinstance(msg.content, str):
                    return msg.content
                elif isinstance(msg.content, list):
                    for part in msg.content:
                        if isinstance(part, str):
                            return part
                        elif hasattr(part, "text"):
                            return part.text
        return ""

    async def _run(self) -> None:
        """Execute LLM request with streaming sentence output."""
        request_id = str(uuid.uuid4())
        user_message = self._extract_user_message()

        if not user_message:
            logger.warning("No user message found in context")
            chunk = ChatChunk(
                id=request_id,
                delta=ChoiceDelta(role="assistant", content="I didn't hear anything."),
            )
            self._event_ch.send_nowait(chunk)
            return

        # NOTE: Single-orchestrator rule.
        # We intentionally DO NOT run a local is_background_task() heuristic +
        # /api/voice/spawn here. That was a second, redundant orchestrator: it
        # spawned a claude_coder subagent from a crude keyword match WHILE the
        # gateway orchestrator (VOICE_ORCHESTRATOR_LINES, injected into
        # /api/voice/chat/stream) independently decided converse-vs-delegate.
        # The two raced and double-fired — the user heard "a subagent ran
        # instantly" (this path) AND "the agent did the task and replied" (the
        # gateway path) for one utterance.
        #
        # The docker voice-agent is now a dumb pipe: STT -> forward text to the
        # gateway -> speak the gateway's reply. The gateway orchestrator is the
        # ONLY brain that decides whether to delegate, and it already emits a
        # snappy spoken ack via server-voice-stream's spawn-receipt intercept.
        # (spawn_background_task / is_background_task are kept but unused so the
        # fallback HTTP plumbing stays available if ever needed.)

        # Try streaming endpoint first
        try:
            streamed = False
            async for sentence in self._infinibot_llm.stream_gateway(user_message):
                if sentence:
                    streamed = True
                    logger.info(f"[Stream Chunk] '{sentence[:50]}...'")
                    chunk = ChatChunk(
                        id=request_id,
                        delta=ChoiceDelta(role="assistant", content=sentence + " "),
                    )
                    self._event_ch.send_nowait(chunk)
                    # Small delay between chunks for natural pacing
                    await asyncio.sleep(0.05)
            
            if streamed:
                return
        except Exception as e:
            logger.warning(f"Streaming failed, falling back to sync: {e}")

        # Fallback: Get full response and stream by sentence
        response = await self._infinibot_llm.call_gateway(user_message)
        sentences = split_into_sentences(response)

        if not sentences:
            # Empty response - send nothing (silent)
            return

        # Stream sentence by sentence for faster perceived response
        for i, sentence in enumerate(sentences):
            chunk = ChatChunk(
                id=request_id,
                delta=ChoiceDelta(role="assistant", content=sentence + (" " if i < len(sentences) - 1 else "")),
            )
            self._event_ch.send_nowait(chunk)
            # Tiny delay between sentences for natural flow
            await asyncio.sleep(0.02)


class InfiniBotAgent(Agent):
    """Voice agent that routes through InfiniBot via a STREAMING llm_node.

    Rather than the default `Agent.llm_node` (which drives the configured LLM
    plugin as a request/response call), this overrides `llm_node` to OPEN the
    gateway's existing SSE stream (`/api/voice/chat/stream`) and YIELD tokens to
    LiveKit as they arrive — so TTS starts before the full reply is generated.

    The gateway keeps owning model selection, the voice-orchestrator system
    prompt, and tool routing (all server-side); we only change the transport
    from blocking to token-streaming. Two reliability behaviors are added:
      • runId capture → barge-in can cancel the in-flight gateway run.
      • stale-response discard → tokens for a superseded user turn are dropped
        (mirrors ROBOVOICE src/caal/llm/llm_node.py:1485-1509).
    """

    def __init__(self, infinibot_llm: "InfiniBotLLM"):
        super().__init__(
            instructions=f"You are {AGENT_NAME}. Keep responses brief and conversational for voice."
        )
        self._infinibot_llm = infinibot_llm
        # Monotonic counter bumped on each committed user turn (see
        # note_user_turn). Snapshotted at the top of llm_node; if it advances
        # mid-stream a newer utterance has superseded this reply.
        self._user_turn_generation = 0
        # runId of the gateway run currently streaming — used to cancel on
        # barge-in. None between turns.
        self._current_run_id: str | None = None
        logger.info(f"InfiniBotAgent initialized: {AGENT_NAME}")

    def note_user_turn(self) -> None:
        """Mark that a newer committed user utterance now exists."""
        self._user_turn_generation += 1

    def cancel_current_run(self) -> None:
        """Fire-and-forget cancel of the in-flight gateway run (barge-in)."""
        run_id = self._current_run_id
        if not run_id:
            return
        logger.info(f"[Barge-in] cancelling in-flight run {run_id}")
        asyncio.create_task(self._infinibot_llm.cancel_run(run_id))

    def _extract_user_message(self, chat_ctx) -> str:
        """Pull the latest user utterance out of the chat context.

        LiveKit 1.x exposes `chat_ctx.items` (ChatMessage w/ `text_content`);
        older builds expose `chat_ctx.messages()`. Handle both.
        """
        items = getattr(chat_ctx, "items", None)
        if items:
            for item in reversed(list(items)):
                if getattr(item, "role", None) != "user":
                    continue
                txt = getattr(item, "text_content", None)
                if isinstance(txt, str) and txt.strip():
                    return txt
                content = getattr(item, "content", None)
                if isinstance(content, str) and content.strip():
                    return content
                if isinstance(content, list):
                    for part in content:
                        if isinstance(part, str) and part.strip():
                            return part
                        t = getattr(part, "text", None)
                        if isinstance(t, str) and t.strip():
                            return t
        messages = getattr(chat_ctx, "messages", None)
        if callable(messages):
            for msg in reversed(list(messages())):
                if getattr(msg, "role", None) != "user":
                    continue
                content = getattr(msg, "content", None)
                if isinstance(content, str) and content.strip():
                    return content
                if isinstance(content, list):
                    for part in content:
                        if isinstance(part, str) and part.strip():
                            return part
                        t = getattr(part, "text", None)
                        if isinstance(t, str) and t.strip():
                            return t
        return ""

    async def llm_node(self, chat_ctx, tools, model_settings):
        """STREAMING LLM node — yields gateway SSE tokens incrementally.

        No single blocking `await` of the full response: we iterate the SSE
        stream and `yield` each token as it arrives (Acceptance A).
        """
        user_message = self._extract_user_message(chat_ctx)
        if not user_message:
            logger.warning("No user message found in context")
            yield "I didn't hear anything."
            return

        # Snapshot the turn generation. If a newer user turn commits while we
        # stream, drop the now-stale remaining tokens (Acceptance D).
        turn_generation = self._user_turn_generation
        self._current_run_id = None
        try:
            async for kind, value in self._infinibot_llm.stream_gateway_events(user_message):
                if kind == "runid":
                    # Capture the gateway runId so a barge-in can cancel it.
                    self._current_run_id = value
                    logger.info(f"[Stream] gateway runId={value}")
                    continue
                # kind == "text": stale-response discard — a newer committed
                # user turn means this reply is one-behind; stop yielding.
                if self._user_turn_generation != turn_generation:
                    logger.info(
                        "[Stale] Discarding gateway tokens for superseded user turn "
                        f"(gen {turn_generation} < {self._user_turn_generation})"
                    )
                    return
                if value:
                    logger.info(f"[Stream Chunk] '{value[:50]}...'")
                    yield value
        finally:
            self._current_run_id = None


# Create the agent server. num_idle_processes is the count of prewarmed
# workers held ready for incoming LiveKit job requests; with concurrent
# voice tabs (unique room names) each tab consumes one process at dispatch,
# so we keep a deeper bench so the 3rd-6th tab doesn't pay startup latency.
server = AgentServer(
    num_idle_processes=4,
)


def prewarm(proc: JobProcess):
    """Prewarm VAD model.

    Tuned for barge-in reliability (mirrors ROBOVOICE): a slightly higher
    activation_threshold rejects room noise / TTS bleed, and a 0.25s minimum
    speech duration avoids false interrupts on short transients while still
    catching a genuine barge-in quickly.
    """
    logger.info(f"Prewarming process {proc.pid}")
    proc.userdata["vad"] = silero.VAD.load(
        activation_threshold=0.55,
        min_speech_duration=0.25,
    )


server.setup_fnc = prewarm


async def publish_transcript(room: rtc.Room, role: str, text: str):
    """Publish transcript data to room for UI display."""
    if not text or not text.strip():
        return
    try:
        data = json.dumps({
            "type": "transcript",
            "role": role,
            "text": text.strip(),
        }).encode("utf-8")
        await room.local_participant.publish_data(data, reliable=True)
    except Exception as e:
        logger.warning(f"Failed to publish transcript: {e}")


async def publish_state(room: rtc.Room, thinking: bool = False, processing: bool = False):
    """Publish AI state to room for UI display."""
    try:
        data = json.dumps({
            "type": "state",
            "thinking": thinking,
            "processing": processing,
        }).encode("utf-8")
        await room.local_participant.publish_data(data, reliable=True)
    except Exception as e:
        logger.warning(f"Failed to publish state: {e}")


async def publish_task_update(room: rtc.Room, task_id: str, status: str, message: str):
    """Publish task completion update to room."""
    try:
        data = json.dumps({
            "type": "task_update",
            "taskId": task_id,
            "status": status,
            "message": message,
        }).encode("utf-8")
        await room.local_participant.publish_data(data, reliable=True)
        logger.info(f"[Task Update] {task_id}: {status} - {message[:50]}")
    except Exception as e:
        logger.warning(f"Failed to publish task update: {e}")


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    """Voice agent entry point."""
    logger.info(f"=== InfiniBot Voice Agent Starting ===")
    logger.info(f"Room: {ctx.room.name}")
    logger.info(f"Gateway: {INFINIBOT_GATEWAY_URL}")

    await ctx.connect()
    logger.info(f"Connected to room: {ctx.room.name}")

    participant = await ctx.wait_for_participant()
    logger.info(f"Participant joined: {participant.identity}")

    # Initialize STT/TTS
    try:
        from livekit.plugins import openai as lk_openai

        # Local Speaches STT - Use medium model (small not installed)
        stt = lk_openai.STT(
            base_url="http://infinibot-speaches:8000/v1",
            model="Systran/faster-whisper-medium",
            api_key="not-needed"
        )
        # OpenAI-compatible TTS via our direct-HTTP adapter. URL and voice
        # come from env so the same code path works against:
        #   • Kokoro-FastAPI (legacy, Kokoro voice names like "am_puck")
        #   • openedai-speech / Piper (current default — OpenAI voice names
        #     like "nova", "onyx", "shimmer")
        # Model name is "tts-1" (the OpenAI standard); openedai-speech accepts
        # it and the old Kokoro-FastAPI image accepted any string.
        tts_base_urls = resolve_kokoro_base_urls(os.getenv("KOKORO_URL"))
        tts_voice = os.getenv("TTS_VOICE", "nova")
        tts = KokoroTTS(
            base_urls=tts_base_urls,
            model="tts-1",
            voice=tts_voice,
        )
        logger.info(f"Using LOCAL STT (Speaches) + TTS ({tts_base_urls}, voice: {tts_voice})")
    except Exception as e:
        logger.error(f"Local STT/TTS unavailable: {e}")
        return

    # Create session with room name for task callbacks
    infinibot_llm = InfiniBotLLM(room_name=ctx.room.name)
    
    # Tuned VAD for faster response
    vad = ctx.proc.userdata["vad"]
    
    # Interruption / barge-in knobs mirrored from ROBOVOICE's AgentSession
    # (voice_agent.py ~2136-2160). These give natural barge-in: the user can
    # cut in mid-reply, brief false interrupts auto-resume, and endpointing
    # waits long enough not to chop the user off.
    session = AgentSession(
        vad=vad,
        stt=stt,
        tts=tts,
        llm=infinibot_llm,
        allow_interruptions=True,
        discard_audio_if_uninterruptible=False,
        min_interruption_duration=0.4,
        resume_false_interruption=True,
        false_interruption_timeout=1.0,
        min_endpointing_delay=0.8,
    )

    # The streaming Agent instance — holds the user-turn generation counter and
    # the current gateway runId, so barge-in can cancel the run and stale
    # replies get dropped. Reused as the `agent=` arg to session.start below.
    agent = InfiniBotAgent(infinibot_llm)

    last_user_transcript = ""
    last_agent_transcript = ""

    # ── Self-echo guard ────────────────────────────────────────────────────
    # Hard-mute the agent's mic input while it is speaking so Kokoro TTS
    # playing through the user's speakers can't bleed back into the mic, get
    # transcribed by Speaches, and be fed to the LLM as a "user" turn — which
    # loops the agent's own words back into itself. Hardware AEC is unreliable
    # across browser/OS/mic combos, so we gate at the framework level.
    #
    # Reliability is the whole point here, so the guard is deliberately
    # belt-and-suspenders:
    #   • Mute is driven from BOTH `agent_state_changed → speaking` AND
    #     `agent_speech_started`. Whichever fires first mutes; the other is a
    #     no-op. Relying on a single event meant one missed/renamed signal left
    #     the mic hot for an entire reply.
    #   • A single `_echo["speaking"]` flag is the source of truth and the
    #     delayed unmute re-checks it, so an unmute scheduled at the end of
    #     sentence N can't fire while sentence N+1 is still playing (a
    #     multi-sentence reply dips out of "speaking" between TTS segments).
    #   • The settle delay covers the speaker→air→mic tail after playback
    #     stops. 0.4s was too short on buffered audio stacks; default 0.8s.
    _echo: dict = {"speaking": False, "reopen_task": None}
    ECHO_SETTLE_SECONDS = float(os.getenv("VOICE_ECHO_SETTLE_SECONDS", "0.8"))

    def _set_mic_enabled(enabled: bool) -> None:
        try:
            session.input.set_audio_enabled(enabled)
            logger.info(f"[Echo] Input {'unmuted' if enabled else 'muted'}")
        except Exception as e:
            logger.warning(f"[Echo] set_audio_enabled({enabled}) failed: {e}")

    def _begin_speaking() -> None:
        # Cancel any pending unmute so we never reopen the mic mid-speech.
        t = _echo["reopen_task"]
        if t and not t.done():
            t.cancel()
        _echo["reopen_task"] = None
        if not _echo["speaking"]:
            _echo["speaking"] = True
            _set_mic_enabled(False)

    def _end_speaking() -> None:
        if not _echo["speaking"]:
            return
        _echo["speaking"] = False
        t = _echo["reopen_task"]
        if t and not t.done():
            t.cancel()

        async def _reopen():
            await asyncio.sleep(ECHO_SETTLE_SECONDS)
            # A new reply may have started during the settle window — if so,
            # leave the mic muted; the next _end_speaking will reopen it.
            if _echo["speaking"]:
                return
            _set_mic_enabled(True)

        _echo["reopen_task"] = asyncio.create_task(_reopen())

    @session.on("user_speech_committed")
    def on_user_speech(msg):
        nonlocal last_user_transcript
        text = ""
        if hasattr(msg, "content"):
            if isinstance(msg.content, str):
                text = msg.content
            elif isinstance(msg.content, list):
                for part in msg.content:
                    if isinstance(part, str):
                        text = part
                        break
                    elif hasattr(part, "text"):
                        text = part.text
                        break
        
        if text and text != last_user_transcript:
            last_user_transcript = text
            logger.info(f"[User] {text[:80]}...")
            # A newer committed user turn supersedes any in-flight reply. Bump
            # the generation so llm_node drops stale gateway tokens, and cancel
            # the previous run on the backend so it stops generating.
            agent.note_user_turn()
            agent.cancel_current_run()
            asyncio.create_task(publish_transcript(ctx.room, "user", text))
            asyncio.create_task(publish_state(ctx.room, thinking=True, processing=True))

    @session.on("agent_speech_started")
    def on_agent_start(msg):
        # Earliest reliable "the agent is making sound now" signal — mute the
        # mic here too (redundant with the speaking-state handler below) so a
        # missed agent_state_changed event can't leave the mic hot.
        _begin_speaking()
        asyncio.create_task(publish_state(ctx.room, thinking=False, processing=False))

    # Coarse state-driven mute/unmute. Pairs with the agent_speech_started
    # mute above and the _echo flag/settle machinery defined near the top of
    # the entrypoint — see the "Self-echo guard" notes there.
    @session.on("agent_state_changed")
    def on_agent_state(ev):
        new_state = getattr(ev, "new_state", None) or getattr(ev, "state", None)
        if new_state == "speaking":
            _begin_speaking()
        elif new_state in ("listening", "idle"):
            _end_speaking()

    @session.on("agent_speech_committed")
    def on_agent_speech(msg):
        nonlocal last_agent_transcript
        text = ""
        if hasattr(msg, "content"):
            if isinstance(msg.content, str):
                text = msg.content
            elif isinstance(msg.content, list):
                for part in msg.content:
                    if isinstance(part, str):
                        text = part
                        break
                    elif hasattr(part, "text"):
                        text = part.text
                        break
        
        if text and text != last_agent_transcript:
            last_agent_transcript = text
            logger.info(f"[Agent] {text[:80]}...")
            asyncio.create_task(publish_transcript(ctx.room, "agent", text))

    # Handle data messages for task updates from gateway
    @ctx.room.on("data_received")
    def on_data(data: rtc.DataPacket):
        try:
            msg = json.loads(data.data.decode("utf-8"))
            if msg.get("type") == "task_complete":
                # Gateway notified us a background task completed - speak the
                # result. Guard against double-speak: the normal reply already
                # reaches TTS through the LLM/stream path, so if this data
                # message carries the SAME text we just spoke, dropping it here
                # is the difference between one spoken reply and two. (This is
                # the "data message + LLM response" double-talk path.)
                task_message = (msg.get("message") or "Task completed.").strip()
                if not task_message:
                    return
                if task_message == last_agent_transcript:
                    logger.info("[Task Complete] suppressed duplicate of last spoken reply")
                    return
                logger.info(f"[Task Complete] {task_message[:80]}...")
                # Queue this to be spoken
                asyncio.create_task(session.say(task_message))
        except Exception as e:
            logger.warning(f"Failed to handle data message: {e}")

    # ── Barge-in → cancel the gateway run ────────────────────────────────────
    # When the user starts speaking while the agent is talking, cancel the
    # in-flight gateway run immediately (don't wait for the new turn to fully
    # commit). Event names differ across livekit-agents builds, so register
    # defensively — an unknown name is skipped, not fatal. The committed-turn
    # path in on_user_speech is the backstop that always runs.
    def _on_barge_in(*_args) -> None:
        agent.cancel_current_run()

    def _on_user_state(ev) -> None:
        new_state = getattr(ev, "new_state", None) or getattr(ev, "state", None)
        if new_state == "speaking":
            agent.cancel_current_run()

    def _safe_on(event_name: str, handler) -> None:
        try:
            session.on(event_name, handler)
            logger.info(f"[Barge-in] subscribed to '{event_name}'")
        except Exception as e:
            logger.warning(f"[Barge-in] could not subscribe to '{event_name}': {e}")

    _safe_on("user_started_speaking", _on_barge_in)
    _safe_on("user_state_changed", _on_user_state)

    logger.info("Starting agent session...")
    # close_on_disconnect=False so the agent stays alive across browser
    # reconnect blips. The default (True) was closing the session 0.4s after
    # start when the browser's initial WebRTC handshake produced a transient
    # "user disconnected" → STT/transcription died before any audio arrived,
    # presenting as "transcription not working." Worker is short-lived
    # anyway (one job per room), so leaking is not a concern.
    await session.start(
        room=ctx.room,
        agent=agent,
        room_input_options=RoomInputOptions(close_on_disconnect=False),
    )
    logger.info("=== Voice Agent Ready (Streaming + Async Tasks) ===")


if __name__ == "__main__":
    logger.info("Starting InfiniBot Voice Agent Worker (Optimized)...")
    cli.run_app(server)
