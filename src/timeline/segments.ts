import type { AudioSegment } from '../audio/AudioPreview';
import type { PreparedTrack } from '../backend/types';
import type { LaidClip, TimelineClip } from './model';

/** Preview audio: one segment per enabled track of every video clip whose media has prepared PCM. */
export function audioSegments(
  laid: LaidClip[],
  prepared: (mediaId: string) => PreparedTrack[] | null,
  curves: (clip: TimelineClip) => Map<number, Float32Array>,
): AudioSegment[] {
  const out: AudioSegment[] = [];
  for (const e of laid) {
    const { clip } = e;
    if (clip.kind !== 'video') continue;
    const tracks = prepared(clip.mediaId);
    if (!tracks) continue;
    const cs = curves(clip);
    for (const t of clip.mix.tracks) {
      if (!t.enabled) continue;
      const p = tracks.find((x) => x.index === t.index);
      const curve = cs.get(t.index);
      if (!p || !curve) continue;
      out.push({
        key: `${clip.id}:${t.index}`,
        pcmPath: p.pcmPath,
        totalFrames: p.frames,
        srcStartS: clip.inS - t.offsetS,
        timelineStartS: e.startS,
        durationS: e.durS,
        rate: clip.speed,
        ceilingDb: t.ceilingDb,
        curve,
      });
    }
  }
  return out;
}
