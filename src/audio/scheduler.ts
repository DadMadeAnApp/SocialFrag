import { PCM_RATE, frameAt } from './pcm';

export const CHUNK_FRAMES = PCM_RATE;
export const LOOKAHEAD_S = 2;

/**
 * A stretch of one track's PCM placed on the timeline: timeline time T plays source time
 * srcStartS + (T - timelineStartS) * rate, for T in [timelineStartS, timelineStartS + durationS).
 * srcStartS already includes the track's sync offset and may be negative (silence until source 0).
 * rate > 1 plays the source faster and higher, like the export's asetrate.
 */
export interface Segment { pcmPath: string; totalFrames: number; srcStartS: number; timelineStartS: number; durationS: number; rate: number }
/** Next source frame to queue, the frame to stop at, and the context time `frame` plays at. */
export interface Cursor { frame: number; endFrame: number; when: number }
export interface Chunk { startFrame: number; frames: number; when: number }

export function startCursor(seg: Segment, t: number, now: number): Cursor | null {
  if (t >= seg.timelineStartS + seg.durationS) return null;
  const from = Math.max(t, seg.timelineStartS);
  let srcT = seg.srcStartS + (from - seg.timelineStartS) * seg.rate;
  let when = now + (from - t);
  if (srcT < 0) {
    when += -srcT / seg.rate;
    srcT = 0;
  }
  const endFrame = Math.min(seg.totalFrames, Number.isFinite(seg.durationS) ? frameAt(seg.srcStartS + seg.durationS * seg.rate) : seg.totalFrames);
  const frame = frameAt(srcT);
  if (frame >= endFrame) return null;
  return { frame, endFrame, when };
}

/**
 * Chunks to queue so the track is covered up to now + LOOKAHEAD_S. A cursor that fell behind the
 * clock (refills paused while the window was hidden) jumps to now first rather than reading the
 * missed stretch only to drop it as late.
 */
export function planChunks(cursor: Cursor, now: number, rate: number): { chunks: Chunk[]; cursor: Cursor } {
  const chunks: Chunk[] = [];
  let { frame, when } = cursor;
  if (when < now) {
    frame = Math.min(cursor.endFrame, frame + Math.round((now - when) * rate * PCM_RATE));
    when = now;
  }
  while (when < now + LOOKAHEAD_S && frame < cursor.endFrame) {
    const frames = Math.min(CHUNK_FRAMES, cursor.endFrame - frame);
    chunks.push({ startFrame: frame, frames, when });
    frame += frames;
    when += frames / PCM_RATE / rate;
  }
  return { chunks, cursor: { frame, endFrame: cursor.endFrame, when } };
}
