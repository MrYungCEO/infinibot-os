/**
 * Recorded clip (WebM / Ogg / MP4 from MediaRecorder) → 16 kHz mono 16-bit
 * WAV, decoded by the browser. The built-in voice engine reads WAV without any
 * extra tools, and Speaches takes it too. Falls back to the original clip when
 * the browser can't decode it.
 */

export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export async function clipToWav(clip: Blob, rate = 16000): Promise<Blob> {
  if (clip.type.includes("wav")) return clip;
  try {
    const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Ctx) return clip;
    const data = await clip.arrayBuffer();
    // Decode at the target rate: the browser resamples for us.
    const decoder = new Ctx(1, 1, rate);
    const audio = await decoder.decodeAudioData(data);
    const offline = new Ctx(1, Math.max(1, Math.ceil(audio.duration * rate)), rate);
    const src = offline.createBufferSource();
    src.buffer = audio;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return new Blob([encodeWav16(rendered.getChannelData(0), rate)], { type: "audio/wav" });
  } catch {
    return clip;
  }
}
