import { expect, test } from 'vitest';
import type { PreparedTrack } from '../backend/types';
import type { TrackMix } from '../types';
import { layoutClips, type TimelineClip } from './model';
import { audioSegments } from './segments';

const track = (o: Partial<TrackMix> = {}): TrackMix => ({ index: 0, sourceLabel: 'G', label: 'G', enabled: true, gain: 1, ceilingDb: -3, offsetS: 0.25, fadeInS: 0, fadeOutS: 0, mutes: [], ...o });
const clip = (id: string, o: Partial<TimelineClip> = {}): TimelineClip => ({
  id, kind: 'video', mediaId: 'm', inS: 10, outS: 14, speed: 1, presetId: 'p', layers: [], mix: { tracks: [track(), track({ index: 1, enabled: false })], duck: null }, captions: [], captionStyles: {}, ...o,
});
const prepared: PreparedTrack[] = [0, 1].map((index) => ({ index, pcmPath: `/p/track-${index}.pcm`, frames: 48000 * 60, envelope: new Float32Array() }));
const curve = new Float32Array([1, 1]);

test('one segment per enabled track, placed on the timeline with offset and speed', () => {
  const laid = layoutClips([clip('a'), clip('b', { speed: 2, inS: 30, outS: 34 })]);
  const segs = audioSegments(laid, () => prepared, () => new Map([[0, curve], [1, curve]]));
  expect(segs.map((s) => [s.key, s.pcmPath, s.srcStartS, s.timelineStartS, s.durationS, s.rate, s.ceilingDb])).toEqual([
    ['a:0', '/p/track-0.pcm', 9.75, 0, 4, 1, -3],
    ['b:0', '/p/track-0.pcm', 29.75, 4, 2, 2, -3],
  ]);
  expect(segs[0].curve).toBe(curve);
});

test('freeze frames and media without prepared audio have no segments', () => {
  const laid = layoutClips([clip('a', { kind: 'freeze', inS: 3, outS: 6 }), clip('b', { mediaId: 'other' })]);
  expect(audioSegments(laid, (id) => (id === 'm' ? prepared : null), () => new Map([[0, curve]]))).toEqual([]);
});
