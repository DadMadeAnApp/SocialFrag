import { expect, test } from 'vitest';
import { LOOKAHEAD_S, planChunks, startCursor, type Segment } from './scheduler';

const whole = (over: Partial<Segment> = {}): Segment => ({ pcmPath: 'p', totalFrames: 48000 * 100, srcStartS: 0, timelineStartS: 0, durationS: Infinity, rate: 1, ...over });

test('startCursor at the playhead starts now at the matching frame', () => {
  expect(startCursor(whole(), 12, 5)).toEqual({ frame: 576000, endFrame: 4800000, when: 5 });
});

test('a positive offset (negative srcStartS) delays the start and begins at frame 0', () => {
  expect(startCursor(whole({ srcStartS: -0.5 }), 0, 5)).toEqual({ frame: 0, endFrame: 4800000, when: 5.5 });
  expect(startCursor(whole({ srcStartS: -0.5, rate: 2 }), 0, 5)).toEqual({ frame: 0, endFrame: 4800000, when: 5.25 });
});

test('a negative offset starts later in the file', () => {
  expect(startCursor(whole({ srcStartS: 0.5 }), 1, 0)!.frame).toBe(72000);
});

test('startCursor returns null at or past the end of the audio', () => {
  expect(startCursor(whole(), 100, 0)).toBeNull();
  expect(startCursor(whole({ durationS: 10 }), 10, 0)).toBeNull();
});

test('a segment later on the timeline waits for its start', () => {
  expect(startCursor(whole({ timelineStartS: 20, srcStartS: 3, durationS: 5 }), 18, 0)).toEqual({ frame: 144000, endFrame: 384000, when: 2 });
});

test('a 2x segment reads twice the source per timeline second', () => {
  const c = startCursor(whole({ timelineStartS: 10, srcStartS: 30, durationS: 4, rate: 2 }), 11, 0)!;
  expect(c).toEqual({ frame: 32 * 48000, endFrame: 38 * 48000, when: 0 });
});

test('planChunks queues 1 s chunks up to 2 s ahead and advances the cursor', () => {
  const { chunks, cursor } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 0, 1);
  expect(chunks).toEqual([
    { startFrame: 0, frames: 48000, when: 0 },
    { startFrame: 48000, frames: 48000, when: 1 },
  ]);
  expect(cursor).toEqual({ frame: 96000, endFrame: 4800000, when: 2 });
  expect(planChunks(cursor, 0, 1).chunks).toEqual([]);
  expect(planChunks(cursor, 0.5, 1).chunks).toEqual([{ startFrame: 96000, frames: 48000, when: 2 }]);
});

test('planChunks at 2x rate spaces chunks by half a second', () => {
  const { chunks } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 0, 2);
  expect(chunks.map((c) => c.when)).toEqual([0, 0.5, 1, 1.5]);
});

test('the last chunk is partial and nothing is planned past the end', () => {
  const { chunks, cursor } = planChunks({ frame: 24000, endFrame: 60000, when: 0 }, 0, 1);
  expect(chunks).toEqual([{ startFrame: 24000, frames: 36000, when: 0 }]);
  expect(planChunks(cursor, 5, 1).chunks).toEqual([]);
});

test('a cursor far behind the clock jumps to now instead of planning the missed chunks', () => {
  const { chunks, cursor } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 60, 1);
  expect(chunks.length).toBeLessThanOrEqual(LOOKAHEAD_S);
  expect(chunks[0]).toEqual({ startFrame: 2880000, frames: 48000, when: 60 });
  expect(cursor).toEqual({ frame: 2976000, endFrame: 4800000, when: 62 });
});

test('a cursor far behind at 2x skips twice the frames', () => {
  const { chunks } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 10, 2);
  expect(chunks[0]).toEqual({ startFrame: 960000, frames: 48000, when: 10 });
});

test('a cursor that falls behind past its end plans nothing', () => {
  const { chunks, cursor } = planChunks({ frame: 0, endFrame: 96000, when: 0 }, 60, 1);
  expect(chunks).toEqual([]);
  expect(cursor.frame).toBe(96000);
});
