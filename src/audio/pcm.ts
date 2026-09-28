/** Preview PCM written by prepare_audio: interleaved s16le stereo at 48 kHz. */
export const PCM_RATE = 48000;
export const PCM_BYTES_PER_FRAME = 4;

export const frameAt = (seconds: number) => Math.max(0, Math.round(seconds * PCM_RATE));

export function s16StereoToPlanar(bytes: ArrayBuffer): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const n = Math.floor(bytes.byteLength / PCM_BYTES_PER_FRAME);
  const v = new DataView(bytes);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = v.getInt16(i * 4, true) / 32768;
    r[i] = v.getInt16(i * 4 + 2, true) / 32768;
  }
  return [l, r];
}
