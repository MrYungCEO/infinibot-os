/**
 * Tiny audio helpers shared by voice providers and the doctor self-test.
 * No external deps — just enough to build/parse 16-bit PCM WAV containers.
 */

/** Wrap raw 16-bit mono PCM in a minimal canonical WAV header. */
export function wavWrap(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Synthesize a 1-second mono sine tone as a 16 kHz PCM WAV. Used by `voice
 * doctor` to exercise the STT roundtrip without bundling an audio asset.
 * Silence transcribes to "" which is still a successful 200 roundtrip.
 */
export function makeToneWav(seconds = 1, freq = 220, sampleRate = 16000): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.25 * 32767);
    pcm.writeInt16LE(sample, i * 2);
  }
  return wavWrap(pcm, sampleRate);
}
