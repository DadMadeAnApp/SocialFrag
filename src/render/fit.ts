import type { Layer, Rect } from '../types';

export interface LayerLayout { crop: Rect; draw: Rect }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** ffmpeg overlays on yuv420p snap to even x/y, so positions are even on both sides. */
const even = (v: number) => 2 * Math.round(v / 2);
/** ffmpeg cannot crop a 1px region from yuv420p. */
const MIN_CROP = 2;

/** Mirrors src-tauri/src/preset.rs `layout_layer` exactly. Change both together. */
export function layoutLayer(layer: Pick<Layer, 'src' | 'dst' | 'fit'>, srcW: number, srcH: number): LayerLayout {
  const { src, dst, fit } = layer;
  let x = clamp(Math.round(src[0] * srcW), 0, srcW - MIN_CROP);
  let y = clamp(Math.round(src[1] * srcH), 0, srcH - MIN_CROP);
  let w = clamp(Math.round(src[2] * srcW), MIN_CROP, srcW - x);
  let h = clamp(Math.round(src[3] * srcH), MIN_CROP, srcH - y);
  const [dx, dy, dw, dh] = dst.map(Math.round) as Rect;

  if (fit === 'cover') {
    const a = dw / dh;
    if (w / h > a) {
      const nw = Math.max(MIN_CROP, Math.round(h * a));
      x += Math.round((w - nw) / 2);
      w = nw;
    } else {
      const nh = Math.max(MIN_CROP, Math.round(w / a));
      y += Math.round((h - nh) / 2);
      h = nh;
    }
    return { crop: [x, y, w, h], draw: [even(dx), even(dy), dw, dh] };
  }

  const s = Math.min(dw / w, dh / h);
  const drawW = Math.max(1, Math.round(w * s));
  const drawH = Math.max(1, Math.round(h * s));
  return { crop: [x, y, w, h], draw: [even(dx + Math.round((dw - drawW) / 2)), even(dy + Math.round((dh - drawH) / 2)), drawW, drawH] };
}
