import type { ClipInfo } from '../types';

const PROBE_CODECS: Record<string, string> = { hev1: 'hev1.1.6.L93.B0', hvc1: 'hvc1.1.6.L93.B0', avc1: 'avc1.640028' };

/** False when the webview says it can't decode this clip's video, so the preview must use the H.264 proxy.
 * WebKit (macOS) plays HEVC tagged hvc1 but not hev1, which OBS writes — and it fails silently (no error event). */
export function webviewCanPlay(info: ClipInfo, canPlayType: (type: string) => string): boolean {
  const tag = info.codecTag?.toLowerCase();
  if (!tag) return true;
  return canPlayType(`video/mp4; codecs="${PROBE_CODECS[tag] ?? tag}"`) !== '';
}
