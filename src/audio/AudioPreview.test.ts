import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AudioPreview, curveFrom, driftExceeded, type AudioSegment } from './AudioPreview';

function makeFakeClock() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentTime: 0,
    paused: true,
    addEventListener(ev: string, fn: () => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(fn);
    },
    removeEventListener(ev: string, fn: () => void) {
      listeners.get(ev)?.delete(fn);
    },
    fire(ev: string) {
      listeners.get(ev)?.forEach((fn) => fn());
    },
  };
}

type Started = { when: number; offset: number; frames: number; rate: number; stopped: boolean };
const param = () => ({ value: 0, cancelScheduledValues: () => {}, setValueAtTime: () => {}, setValueCurveAtTime: () => {} });
function makeFakeCtx() {
  const started: Started[] = [];
  const node = () => ({ connect: (n: unknown) => n, disconnect: () => {} });
  const ctx = {
    started,
    currentTime: 0,
    destination: {},
    createDynamicsCompressor: () => ({ ...node(), threshold: { value: 0 }, ratio: { value: 0 }, knee: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }),
    createGain: () => ({ ...node(), gain: param() }),
    createBuffer: (_ch: number, frames: number) => ({ frames, copyToChannel: () => {} }),
    createBufferSource: () => {
      const rec: Started = { when: -1, offset: -1, frames: 0, rate: 1, stopped: false };
      return {
        buffer: null as null | { frames: number },
        playbackRate: { value: 1 },
        onended: null as null | (() => void),
        connect: () => {},
        disconnect: () => {},
        start(when: number, offset = 0) {
          rec.when = when;
          rec.offset = offset;
          rec.frames = this.buffer?.frames ?? 0;
          rec.rate = this.playbackRate.value;
          started.push(rec);
        },
        stop() {
          rec.stopped = true;
        },
      };
    },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return ctx;
}

const seg = (o: Partial<AudioSegment> = {}): AudioSegment => ({
  key: 'a', pcmPath: '/c/audio/k/track-0.pcm', totalFrames: 48000 * 100, srcStartS: 0, timelineStartS: 0, durationS: Infinity, rate: 1, ceilingDb: null, curve: new Float32Array(), ...o,
});

/** readPcm stub: records requests; resolves immediately unless `hold` is set. */
function makeReader() {
  const calls: { path: string; startFrame: number; frames: number; resolve: () => void }[] = [];
  let hold = false;
  const read = (path: string, startFrame: number, frames: number) =>
    new Promise<ArrayBuffer>((resolve) => {
      const done = () => resolve(new ArrayBuffer(frames * 4));
      calls.push({ path, startFrame, frames, resolve: done });
      if (!hold) done();
    });
  return { read, calls, setHold: (h: boolean) => (hold = h) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Tests drive the preview with explicit pump() calls and a hand-set ctx.currentTime. A real rAF (jsdom
 * has one; this file runs without a DOM, where it's missing) and the 250 ms refill interval would tick on
 * wall-clock time: a frame landing after a test moves ctx.currentTime but not the clock sees "drift" and
 * restarts, re-reading chunks. Frames and refills never fire on their own; a test advances fake timers.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

function setup(segs: AudioSegment[] = [seg()]) {
  const clock = makeFakeClock();
  const ctx = makeFakeCtx();
  const reader = makeReader();
  const preview = new AudioPreview(clock, reader.read, () => ctx as unknown as AudioContext);
  preview.setSegments(segs);
  return { clock, ctx, reader, preview };
}

async function play(s: { clock: ReturnType<typeof makeFakeClock> }, at = 0) {
  s.clock.currentTime = at;
  s.clock.paused = false;
  s.clock.fire('play');
  await flush();
}

test('curveFrom starts at the playhead sample', () => {
  const c = Float32Array.from({ length: 1000 }, (_, i) => i);
  expect(curveFrom(c, 2)[0]).toBe(400);
});

test('driftExceeded flags a clock more than 100 ms from the audio clock', () => {
  expect(driftExceeded(10.2, 10, 0, 0)).toBe(true);
  expect(driftExceeded(10.05, 10, 0, 0)).toBe(false);
});

test('play at 12 s reads two 1 s chunks from frame 576000 and schedules them back to back', async () => {
  const s = setup();
  await play(s, 12);
  expect(s.reader.calls.map((c) => c.startFrame)).toEqual([576000, 624000]);
  expect(s.ctx.started.map((x) => x.when)).toEqual([0, 1]);
  s.preview.dispose();
});

test('pump tops the queue up as the context clock advances', async () => {
  const s = setup();
  await play(s, 0);
  s.ctx.currentTime = 1;
  s.preview.pump();
  await flush();
  expect(s.reader.calls.map((c) => c.startFrame)).toEqual([0, 48000, 96000]);
  s.preview.dispose();
});

test('memory stays bounded: a long play never queues more than 3 chunks at once', async () => {
  const s = setup();
  await play(s, 0);
  for (let t = 0.25; t <= 20; t += 0.25) {
    s.ctx.currentTime = t;
    s.preview.pump();
    await flush();
  }
  expect(s.reader.calls.length).toBeGreaterThanOrEqual(20);
  const live = s.ctx.started.filter((x) => !x.stopped && x.when + 1 > s.ctx.currentTime);
  expect(live.length).toBeLessThanOrEqual(3);
  s.preview.dispose();
});

test('a segment later on the timeline reads nothing until it is inside the lookahead', async () => {
  const s = setup([seg({ timelineStartS: 10, srcStartS: 3, durationS: 5 })]);
  await play(s, 0);
  expect(s.reader.calls).toHaveLength(0);
  s.ctx.currentTime = 8.5;
  s.preview.pump();
  await flush();
  expect(s.reader.calls[0].startFrame).toBe(3 * 48000);
  expect(s.ctx.started[0].when).toBe(10);
  s.preview.dispose();
});

test('a 2x segment plays its chunks at playbackRate 2, half a second apart', async () => {
  const s = setup([seg({ rate: 2 })]);
  await play(s, 0);
  expect(s.ctx.started.map((x) => [x.when, x.rate])).toEqual([[0, 2], [0.5, 2], [1, 2], [1.5, 2]]);
  s.preview.dispose();
});

test('back-to-back segments on two files hand over at the cut', async () => {
  const s = setup([
    seg({ key: 'c1:0', pcmPath: '/a.pcm', durationS: 1.5 }),
    seg({ key: 'c2:0', pcmPath: '/b.pcm', timelineStartS: 1.5, srcStartS: 20, durationS: 5 }),
  ]);
  await play(s, 0);
  expect(s.reader.calls.map((c) => [c.path, c.startFrame, c.frames])).toEqual([
    ['/a.pcm', 0, 48000],
    ['/a.pcm', 48000, 24000],
    ['/b.pcm', 20 * 48000, 48000],
  ]);
  expect(s.ctx.started.map((x) => x.when)).toEqual([0, 1, 1.5]);
  s.preview.dispose();
});

test('stale chunk: a read that resolves after a seek is dropped', async () => {
  const s = setup();
  s.reader.setHold(true);
  await play(s, 0);
  const pending = s.reader.calls.slice();
  s.reader.setHold(false);
  s.clock.currentTime = 40;
  s.clock.fire('seeked');
  await flush();
  pending.forEach((c) => c.resolve());
  await flush();
  expect(s.reader.calls.at(-2)!.startFrame).toBe(1920000);
  expect(s.ctx.started).toHaveLength(2);
  s.preview.dispose();
});

test('late chunk: starts part-way in at the right position, or is dropped if fully late', async () => {
  const s = setup();
  s.reader.setHold(true);
  await play(s, 0);
  s.ctx.currentTime = 0.3;
  s.reader.calls[0].resolve();
  await flush();
  expect(s.ctx.started[0]).toMatchObject({ when: 0.3 });
  expect(s.ctx.started[0].offset).toBeCloseTo(0.3);
  s.ctx.currentTime = 2.5;
  s.reader.calls[1].resolve();
  await flush();
  expect(s.ctx.started).toHaveLength(1);
  s.preview.dispose();
});

test('positive offset: first chunk starts at frame 0, delayed by the offset', async () => {
  const s = setup([seg({ srcStartS: -0.5 })]);
  await play(s, 0);
  expect(s.reader.calls[0].startFrame).toBe(0);
  expect(s.ctx.started[0].when).toBeCloseTo(0.5);
  s.preview.dispose();
});

test('near the end: one partial chunk, nothing past the last frame', async () => {
  const s = setup([seg({ totalFrames: 60000 })]);
  await play(s, 0.5);
  s.ctx.currentTime = 3;
  s.preview.pump();
  await flush();
  expect(s.reader.calls.map((c) => [c.startFrame, c.frames])).toEqual([[24000, 36000]]);
  s.preview.dispose();
});

test('pause stops queued sources and stops reading', async () => {
  const s = setup();
  await play(s, 0);
  s.clock.paused = true;
  s.clock.fire('pause');
  const n = s.reader.calls.length;
  s.ctx.currentTime = 5;
  s.preview.pump();
  expect(s.ctx.started.every((x) => x.stopped)).toBe(true);
  expect(s.reader.calls).toHaveLength(n);
  s.preview.dispose();
});

test('no segments read nothing', async () => {
  const s = setup([]);
  await play(s, 0);
  expect(s.reader.calls).toHaveLength(0);
  s.preview.dispose();
});

test('a curve-only change keeps the queue; a timing change restarts it; a removed segment stops', async () => {
  const s = setup();
  await play(s, 0);
  const n = s.reader.calls.length;
  s.preview.setSegments([seg({ curve: new Float32Array([0.5, 0.5]) })]);
  expect(s.reader.calls).toHaveLength(n);
  s.preview.setSegments([seg({ srcStartS: -0.3 })]);
  await flush();
  expect(s.reader.calls.length).toBeGreaterThan(n);
  expect(s.ctx.started.slice(0, 2).every((x) => x.stopped)).toBe(true);
  s.preview.setSegments([]);
  expect(s.ctx.started.every((x) => x.stopped)).toBe(true);
  s.preview.dispose();
});

/** No rAF (window hidden/minimised) and a manual interval clock, so only explicit pumps and interval ticks refill. */
function withoutRaf() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('returning after 60 s without refills reads at most the lookahead, not the missed minute', async () => {
  withoutRaf();
  const s = setup();
  await play(s, 0);
  const n = s.reader.calls.length;
  s.ctx.currentTime = 60;
  s.preview.pump();
  await flush();
  const fresh = s.reader.calls.slice(n);
  expect(fresh.length).toBeLessThanOrEqual(3);
  expect(fresh[0].startFrame).toBe(60 * 48000);
  s.preview.dispose();
});

test('the queue refills on a timer when rAF is not running', async () => {
  withoutRaf();
  const s = setup();
  await play(s, 0);
  const n = s.reader.calls.length;
  s.ctx.currentTime = 1;
  vi.advanceTimersByTime(250);
  await flush();
  expect(s.reader.calls.length).toBeGreaterThan(n);
  s.preview.dispose();
});

test('dispose stops the refill timer', async () => {
  withoutRaf();
  const s = setup();
  await play(s, 0);
  s.preview.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

/** Preview over `count` segments whose reads succeed or fail per `ok(path, callNo)`. */
function setupFailing(ok: (path: string, call: number) => boolean, count = 1) {
  const clock = makeFakeClock();
  const ctx = makeFakeCtx();
  const counts = new Map<string, number>();
  const read = (path: string, _start: number, frames: number) => {
    const call = (counts.get(path) ?? 0) + 1;
    counts.set(path, call);
    return ok(path, call) ? Promise.resolve(new ArrayBuffer(frames * 4)) : Promise.reject(new Error('gone'));
  };
  const onError = vi.fn();
  const preview = new AudioPreview(clock, read, () => ctx as unknown as AudioContext, onError);
  preview.setSegments(Array.from({ length: count }, (_, i) => seg({ key: `k${i}`, pcmPath: `/c/audio/k/track-${i}.pcm` })));
  return { clock, ctx, preview, onError, counts };
}

async function pumpFor(s: { ctx: { currentTime: number }; preview: AudioPreview }, seconds: number) {
  for (let t = s.ctx.currentTime + 1; t <= seconds; t++) {
    s.ctx.currentTime = t;
    s.preview.pump();
    await flush();
  }
}

test('reads that keep failing report once', async () => {
  withoutRaf();
  const s = setupFailing(() => false);
  await play(s, 0);
  await pumpFor(s, 10);
  expect(s.counts.get('/c/audio/k/track-0.pcm')).toBeGreaterThanOrEqual(6);
  expect(s.onError).toHaveBeenCalledTimes(1);
  s.preview.dispose();
});

test('two failures then a success report nothing', async () => {
  withoutRaf();
  const s = setupFailing((_p, call) => call > 2);
  await play(s, 0);
  await pumpFor(s, 10);
  expect(s.onError).not.toHaveBeenCalled();
  s.preview.dispose();
});

test('one failing segment out of two reports nothing', async () => {
  withoutRaf();
  const s = setupFailing((p) => p.endsWith('track-1.pcm'), 2);
  await play(s, 0);
  await pumpFor(s, 10);
  expect(s.onError).not.toHaveBeenCalled();
  s.preview.dispose();
});

test('a success after a report re-arms it', async () => {
  withoutRaf();
  const s = setupFailing((_p, call) => call === 4 || call > 7);
  await play(s, 0);
  await pumpFor(s, 12);
  expect(s.onError).toHaveBeenCalledTimes(2);
  s.preview.dispose();
});

test('dispose while the context is resuming neither throws nor plays', async () => {
  const s = setup();
  let reject = (_e: Error) => {};
  s.ctx.resume = () => new Promise<void>((_r, j) => (reject = j));
  s.clock.paused = false;
  s.clock.fire('play');
  s.preview.dispose();
  reject(new Error('InvalidStateError: context closed'));
  await flush();
  expect(s.ctx.started).toHaveLength(0);
});
