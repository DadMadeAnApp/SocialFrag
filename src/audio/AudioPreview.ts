import { SAMPLE_RATE } from './curve';
import { PCM_RATE, s16StereoToPlanar } from './pcm';
import { planChunks, startCursor, type Cursor, type Segment } from './scheduler';

const MAX_DRIFT_S = 0.1;
/** Don't restart for drift more often than this; each restart is audible. */
const MIN_RESYNC_GAP_S = 1;
/** Refill period when rAF is paused (window hidden or minimised). */
const REFILL_MS = 250;
/** Consecutive failed reads on every segment that has read before the preview reports itself broken. */
const FAILS_TO_REPORT = 3;

/** The timeline clock audio follows (TimelinePlayer, or a plain video element). Always runs at 1x. */
export interface Clock {
  readonly currentTime: number;
  readonly paused: boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** One clip's track on the timeline. curve = gain at SAMPLE_RATE, in timeline time from timelineStartS. */
export interface AudioSegment extends Segment { key: string; ceilingDb: number | null; curve: Float32Array }

export const curveFrom = (curve: Float32Array, t: number) => curve.subarray(Math.min(curve.length, Math.max(0, Math.floor(t * SAMPLE_RATE))));

/** Where the clock should be now given the (t0, ctxT0) anchor recorded at the last restart. */
export const expectedTime = (t0: number, ctxT0: number, ctxNow: number) => t0 + (ctxNow - ctxT0);
export const driftExceeded = (t: number, t0: number, ctxT0: number, ctxNow: number) => Math.abs(t - expectedTime(t0, ctxT0, ctxNow)) > MAX_DRIFT_S;

export type ReadPcm = (path: string, startFrame: number, frames: number) => Promise<ArrayBuffer>;

interface Node { seg: AudioSegment; cursor: Cursor | null; sources: Set<AudioBufferSourceNode>; gain: GainNode; ceiling: DynamicsCompressorNode; failures: number; tried: boolean }
interface Anchor { t0: number; ctxT0: number }

const timing = (s: Segment) => `${s.pcmPath}|${s.srcStartS}|${s.timelineStartS}|${s.durationS}|${s.rate}`;

/**
 * Streams each segment's PCM in 1 s chunks, scheduled back to back on the AudioContext clock with
 * 2 s queued ahead, through gain curve → ceiling → master limiter. The clock is the timeline:
 * play/seek and segment timing changes drop the queue and refill from the clock's position.
 * Memory is bounded by the queue, not by clip length or clip count.
 */
export class AudioPreview {
  private ctx: AudioContext;
  private master: DynamicsCompressorNode;
  private nodes = new Map<string, Node>();
  private raf = 0;
  private refill: ReturnType<typeof setInterval>;
  private readonly off: (() => void)[] = [];
  private clock: Clock;
  private readPcm: ReadPcm;
  /** Clock/context time pair of the last restart; drift is measured against it. */
  private anchor: Anchor | null = null;
  private lastResync = -Infinity;
  /** Bumped on every restart/stop so chunk reads that resolve afterwards are dropped. */
  private session = 0;
  private disposed = false;
  private onError?: () => void;
  /** onError has fired and no read has succeeded since. */
  private reported = false;

  constructor(clock: Clock, readPcm: ReadPcm, makeContext?: () => AudioContext, onError?: () => void) {
    this.clock = clock;
    this.readPcm = readPcm;
    this.onError = onError;
    this.ctx = makeContext ? makeContext() : new AudioContext({ sampleRate: PCM_RATE });
    this.master = this.ctx.createDynamicsCompressor();
    this.master.threshold.value = -1;
    this.master.ratio.value = 20;
    this.master.knee.value = 0;
    this.master.attack.value = 0.001;
    this.master.release.value = 0.05;
    this.master.connect(this.ctx.destination);
    const on = (ev: string, fn: () => void) => {
      clock.addEventListener(ev, fn);
      this.off.push(() => clock.removeEventListener(ev, fn));
    };
    on('play', () => void this.play());
    on('playing', () => this.restart());
    on('pause', () => this.stop());
    on('waiting', () => this.stop());
    on('seeked', () => (clock.paused ? this.schedule() : this.restart()));
    const tick = () => {
      if (!clock.paused && this.anchor && this.ctx.currentTime - this.lastResync > MIN_RESYNC_GAP_S) {
        if (driftExceeded(clock.currentTime, this.anchor.t0, this.anchor.ctxT0, this.ctx.currentTime)) this.restart();
      }
      this.pump();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.refill = setInterval(() => this.pump(), REFILL_MS);
  }

  setSegments(segs: AudioSegment[]) {
    let restart = false;
    const keep = new Set(segs.map((s) => s.key));
    for (const [key, n] of this.nodes) {
      if (keep.has(key)) continue;
      this.dropNode(n);
      this.nodes.delete(key);
    }
    for (const s of segs) {
      let n = this.nodes.get(s.key);
      if (!n) {
        n = this.makeNode(s);
        this.nodes.set(s.key, n);
        restart = true;
      } else if (timing(n.seg) !== timing(s)) {
        restart = true;
      }
      n.seg = s;
      n.ceiling.threshold.value = s.ceilingDb ?? 0;
      n.ceiling.ratio.value = s.ceilingDb === null ? 1 : 20;
    }
    if (restart && !this.clock.paused) this.restart();
    else this.schedule();
  }

  private makeNode(seg: AudioSegment): Node {
    const gain = this.ctx.createGain();
    const ceiling = this.ctx.createDynamicsCompressor();
    ceiling.knee.value = 0;
    ceiling.attack.value = 0.001;
    ceiling.release.value = 0.05;
    gain.connect(ceiling).connect(this.master);
    return { seg, cursor: null, sources: new Set(), gain, ceiling, failures: 0, tried: false };
  }

  private dropNode(n: Node) {
    this.stopNode(n);
    n.gain.disconnect();
    n.ceiling.disconnect();
  }

  /** Queue chunks up to the lookahead for every segment with a cursor. Called every frame, every REFILL_MS and whenever a chunk ends; public for tests. */
  pump() {
    if (this.disposed || this.clock.paused) return;
    const now = this.ctx.currentTime;
    const session = this.session;
    for (const n of this.nodes.values()) {
      if (!n.cursor) continue;
      const rate = n.seg.rate;
      const plan = planChunks(n.cursor, now, rate);
      n.cursor = plan.cursor;
      for (const c of plan.chunks) {
        n.tried = true;
        this.readPcm(n.seg.pcmPath, c.startFrame, c.frames).then(
          (bytes) => {
            n.failures = 0;
            this.reported = false;
            this.playChunk(n, bytes, c.when, rate, session);
          },
          () => this.readFailed(n),
        );
      }
    }
  }

  private readFailed(n: Node) {
    if (this.disposed) return;
    n.failures++;
    const tried = [...this.nodes.values()].filter((x) => x.tried);
    if (this.reported || !tried.length || tried.some((x) => x.failures < FAILS_TO_REPORT)) return;
    this.reported = true;
    this.onError?.();
  }

  private playChunk(n: Node, bytes: ArrayBuffer, when: number, rate: number, session: number) {
    if (this.disposed || session !== this.session || !this.nodes.has(n.seg.key)) return;
    const [l, r] = s16StereoToPlanar(bytes);
    if (!l.length) return;
    const duration = l.length / PCM_RATE / rate;
    const now = this.ctx.currentTime;
    const late = Math.max(0, now - when);
    if (late >= duration) return;
    const buf = this.ctx.createBuffer(2, l.length, PCM_RATE);
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(n.gain);
    src.onended = () => {
      src.disconnect();
      n.sources.delete(src);
      this.pump();
    };
    src.start(Math.max(when, now), late * rate);
    n.sources.add(src);
  }

  private async play() {
    try {
      await this.ctx.resume();
    } catch {
      return; // dispose() closed the context mid-resume
    }
    if (this.disposed) return;
    if (!this.clock.paused) this.restart();
  }

  private stopNode(n: Node) {
    for (const s of n.sources) {
      try {
        s.stop();
      } catch {
        // never started
      }
      s.disconnect();
    }
    n.sources.clear();
    n.cursor = null;
  }

  private stopSources() {
    this.session++;
    for (const n of this.nodes.values()) this.stopNode(n);
  }

  private stop() {
    this.stopSources();
    this.anchor = null;
    this.schedule();
  }

  /** Drop the queue and start every segment from the clock's current position. */
  private restart() {
    if (this.disposed) return;
    this.stopSources();
    const now = this.ctx.currentTime;
    const t = this.clock.currentTime;
    for (const n of this.nodes.values()) n.cursor = startCursor(n.seg, t, now);
    this.anchor = { t0: t, ctxT0: now };
    this.lastResync = now;
    this.schedule();
    this.pump();
  }

  /** Gain automation from the playhead onwards (future segments from their start); while paused just the current value. */
  private schedule() {
    const now = this.ctx.currentTime;
    const t = this.clock.currentTime;
    for (const n of this.nodes.values()) {
      n.gain.gain.cancelScheduledValues(now);
      const local = t - n.seg.timelineStartS;
      const rest = curveFrom(n.seg.curve, Math.max(0, local));
      if (this.clock.paused || rest.length < 2 || local >= n.seg.durationS) {
        n.gain.gain.setValueAtTime(rest[0] ?? 0, now);
      } else {
        n.gain.gain.setValueCurveAtTime(rest, now + Math.max(0, -local), rest.length / SAMPLE_RATE);
      }
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.refill);
    this.off.forEach((f) => f());
    this.stopSources();
    void this.ctx.close();
  }
}
