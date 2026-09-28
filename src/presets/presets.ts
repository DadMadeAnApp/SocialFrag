import wardogs from './builtin/wardogs.json';
import { validatePreset } from './validate';
import type { Canvas, Preset, RawPresetFile } from '../types';

function mustValidate(raw: unknown): Preset {
  const r = validatePreset(raw);
  if (!r.ok) throw new Error(`built-in preset invalid: ${r.error}`);
  return { ...r.preset, builtin: true };
}

export const BUILTIN_PRESETS: Preset[] = [mustValidate(wardogs)];

export function loadUserPresets(files: RawPresetFile[]): { presets: Preset[]; warnings: string[] } {
  const presets: Preset[] = [];
  const warnings: string[] = [];
  const ids = new Set(BUILTIN_PRESETS.map((p) => p.id));
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(f.contents);
    } catch {
      warnings.push(`${f.file}: not valid JSON`);
      continue;
    }
    const r = validatePreset(raw);
    if (!r.ok) {
      warnings.push(`${f.file}: ${r.error}`);
      continue;
    }
    if (ids.has(r.preset.id)) {
      warnings.push(`${f.file}: duplicate preset id ${r.preset.id}`);
      continue;
    }
    ids.add(r.preset.id);
    presets.push({ ...r.preset, builtin: false });
  }
  return { presets, warnings };
}

export function duplicatePreset(p: Preset, id: string): Preset {
  return { ...structuredClone(p), id, name: `${p.name} (copy)`, builtin: false };
}

export function blankPreset(id: string): Preset {
  return {
    id,
    name: 'New preset',
    game: '',
    version: 1,
    builtin: false,
    background: { type: 'blur', amount: 30 },
    layers: [{ id: 'gameplay', label: 'Gameplay', src: [0.28125, 0, 0.4375, 1], dst: [0, 0, 1080, 1920], fit: 'cover' }],
  };
}

export function presetFileName(p: Preset): string {
  const base = p.name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
  return `${base || 'preset'}.json`;
}

/** Landscape mode: the source frame as recorded, fitted whole on black. Never saved or listed. */
export function fullFramePreset(canvas: Canvas): Preset {
  return {
    id: 'builtin-full-frame', name: 'Full frame', game: '', version: 1, builtin: true,
    background: { type: 'none' },
    layers: [{ id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, canvas.w, canvas.h], fit: 'contain' }],
  };
}
