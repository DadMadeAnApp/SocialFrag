import { AUDIO_LIMITS, VERTICAL_CANVAS, type Background, type Fit, type Layer, type Preset, type PresetAudio, type PresetAudioTrack, type PresetDuck, type Rect } from '../types';

export type ValidationResult = { ok: true; preset: Preset } | { ok: false; error: string };

const EPS = 1e-6;

export const isHexColor = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

const isRect = (v: unknown): v is Rect =>
  Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

function parseBackground(v: any): Background | string {
  if (!v || typeof v !== 'object') return 'background missing';
  if (v.type === 'blur') {
    return typeof v.amount === 'number' && v.amount >= 0 && v.amount <= 100 ? { type: 'blur', amount: v.amount } : 'blur amount must be 0-100';
  }
  if (v.type === 'color') return isHexColor(v.color) ? { type: 'color', color: v.color } : 'background color must be #RRGGBB';
  if (v.type === 'none') return { type: 'none' };
  return `unknown background type ${String(v.type)}`;
}

function parseLayer(v: any, i: number): Layer | string {
  if (!v || typeof v !== 'object') return `layer ${i} is not an object`;
  if (typeof v.id !== 'string' || !v.id) return `layer ${i} needs an id`;
  const id: string = v.id;
  if (!isRect(v.src)) return `layer ${id}: src must be 4 numbers`;
  const [x, y, w, h] = v.src;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + EPS || y + h > 1 + EPS) return `layer ${id}: src outside frame`;
  if (!isRect(v.dst)) return `layer ${id}: dst must be 4 numbers`;
  const [dx, dy, dw, dh] = v.dst;
  if (dx < 0 || dy < 0 || dw < 1 || dh < 1 || dx + dw > VERTICAL_CANVAS.w || dy + dh > VERTICAL_CANVAS.h) return `layer ${id}: dst outside canvas`;
  if (v.fit !== undefined && v.fit !== 'cover' && v.fit !== 'contain') return `layer ${id}: fit must be cover or contain`;
  const fit: Fit = v.fit === 'contain' ? 'contain' : 'cover';
  const layer: Layer = { id, label: typeof v.label === 'string' && v.label ? v.label : id, src: [x, y, w, h], dst: [dx, dy, dw, dh], fit };
  if (v.radius !== undefined) {
    if (typeof v.radius !== 'number' || !Number.isFinite(v.radius) || v.radius < 0) return `layer ${id}: radius must be >= 0`;
    layer.radius = v.radius;
  }
  if (v.border !== undefined) {
    const b = v.border;
    if (!b || typeof b.width !== 'number' || !(b.width > 0) || !isHexColor(b.color)) return `layer ${id}: border needs width > 0 and #RRGGBB color`;
    layer.border = { width: b.width, color: b.color };
  }
  if (v.hidden !== undefined) {
    if (typeof v.hidden !== 'boolean') return `layer ${id}: hidden must be true/false`;
    if (v.hidden) layer.hidden = true;
  }
  return layer;
}

const inRange = (v: unknown, [lo, hi]: readonly [number, number]): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isLabel = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64;

function parseAudioTrack(v: any, i: number): PresetAudioTrack | string {
  if (!v || typeof v !== 'object') return `audio track ${i} is not an object`;
  if (!isLabel(v.label)) return `audio track ${i}: label must be 1-64 characters`;
  if (typeof v.enabled !== 'boolean') return `audio track ${v.label}: enabled must be true/false`;
  if (!inRange(v.gain, AUDIO_LIMITS.gain)) return `audio track ${v.label}: gain must be 0-2`;
  const ceilingDb = v.ceilingDb ?? null;
  if (ceilingDb !== null && !inRange(ceilingDb, AUDIO_LIMITS.ceilingDb)) return `audio track ${v.label}: ceiling must be -24 to 0 dB or null`;
  if (!inRange(v.offsetS, AUDIO_LIMITS.offsetS)) return `audio track ${v.label}: offset must be -2 to 2 s`;
  return { label: v.label, enabled: v.enabled, gain: v.gain, ceilingDb, offsetS: v.offsetS };
}

function parseDuck(v: any): PresetDuck | null | string {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return 'duck must be an object or null';
  if (!Array.isArray(v.targets) || !v.targets.every(isLabel)) return 'duck targets must be track labels';
  if (!Array.isArray(v.triggers) || !v.triggers.every(isLabel)) return 'duck triggers must be track labels';
  if (!inRange(v.amountDb, AUDIO_LIMITS.amountDb)) return 'duck amount must be -24 to 0 dB';
  if (!inRange(v.thresholdDb, AUDIO_LIMITS.thresholdDb)) return 'duck threshold must be -60 to 0 dB';
  if (!inRange(v.releaseS, AUDIO_LIMITS.releaseS)) return 'duck release must be 0.05 to 2 s';
  return { targets: [...v.targets], triggers: [...v.triggers], amountDb: v.amountDb, thresholdDb: v.thresholdDb, releaseS: v.releaseS };
}

function parseAudio(v: any): PresetAudio | string {
  if (!v || typeof v !== 'object' || !Array.isArray(v.tracks)) return 'audio tracks must be a list';
  const tracks: PresetAudioTrack[] = [];
  for (let i = 0; i < v.tracks.length; i++) {
    const t = parseAudioTrack(v.tracks[i], i);
    if (typeof t === 'string') return t;
    tracks.push(t);
  }
  const duck = parseDuck(v.duck);
  if (typeof duck === 'string') return duck;
  return { tracks, duck };
}

export function validatePreset(raw: unknown): ValidationResult {
  const v = raw as any;
  if (!v || typeof v !== 'object') return { ok: false, error: 'preset is not an object' };
  if (v.version !== 1) return { ok: false, error: `unsupported preset version ${String(v.version)}` };
  if (typeof v.id !== 'string' || !v.id) return { ok: false, error: 'preset needs an id' };
  if (typeof v.name !== 'string' || !v.name) return { ok: false, error: 'preset needs a name' };
  const background = parseBackground(v.background);
  if (typeof background === 'string') return { ok: false, error: background };
  if (!Array.isArray(v.layers) || v.layers.length === 0) return { ok: false, error: 'preset needs at least one layer' };
  const layers: Layer[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < v.layers.length; i++) {
    const l = parseLayer(v.layers[i], i);
    if (typeof l === 'string') return { ok: false, error: l };
    if (seen.has(l.id)) return { ok: false, error: `duplicate layer id ${l.id}` };
    seen.add(l.id);
    layers.push(l);
  }
  if (!layers.some((l) => !l.hidden)) return { ok: false, error: 'preset needs at least one visible layer' };
  let audio: PresetAudio | undefined;
  if (v.audio !== undefined) {
    const a = parseAudio(v.audio);
    if (typeof a === 'string') return { ok: false, error: a };
    audio = a;
  }
  return {
    ok: true,
    preset: { id: v.id, name: v.name, game: typeof v.game === 'string' ? v.game : '', version: 1, builtin: v.builtin === true, background, layers, ...(audio ? { audio } : {}) },
  };
}
