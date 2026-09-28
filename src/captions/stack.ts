import { captionLayout, type CaptionPx } from '../render/captions';
import type { Ctx2D } from '../render/ctx';

const GAP = 0.2; // × font size between stacked lines

/** Lines on screen together: placed in track order (manual first); a line whose box overlaps one already placed moves up above it. */
export function stackCaptions(ctx: Ctx2D, lines: CaptionPx[]): CaptionPx[] {
  const order = [...lines].sort((a, b) => (a.trackIndex ?? -1) - (b.trackIndex ?? -1));
  const placed: { c: CaptionPx; top: number; bottom: number; left: number; right: number }[] = [];
  for (const line of order) {
    let c = line;
    for (;;) {
      const { box } = captionLayout(ctx, c);
      const hit = placed.find((p) => box.x < p.right && p.left < box.x + box.w && box.y < p.bottom && p.top < box.y + box.h);
      if (!hit) {
        placed.push({ c, top: box.y, bottom: box.y + box.h, left: box.x, right: box.x + box.w });
        break;
      }
      c = { ...c, y: hit.top - GAP * c.fontSize - box.h / 2 };
    }
  }
  return placed.map((p) => p.c);
}
