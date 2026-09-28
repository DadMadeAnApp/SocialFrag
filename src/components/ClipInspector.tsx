import { formatTime } from '../state/trim';
import type { TimelineClip } from '../timeline/model';
import { NumberField } from './AudioMixer';

interface Props {
  clip: TimelineClip;
  name: string;
  onSpeed(speed: number): void;
  onFreezeLength(seconds: number): void;
  onDelete(): void;
}

export function ClipInspector({ clip, name, onSpeed, onFreezeLength, onDelete }: Props) {
  const freeze = clip.kind === 'freeze';
  return (
    <section className="panel clip-inspector">
      <h2>{freeze ? 'Freeze frame' : 'Clip'}</h2>
      <p className="clip-name">{name}</p>
      <p className="hint">{freeze ? `Frame at ${formatTime(clip.inS)}` : `${formatTime(clip.inS)} – ${formatTime(clip.outS)} of the source`}</p>
      {freeze ? (
        <label className="row">
          Hold <NumberField aria-label="Hold seconds" value={Math.round((clip.outS - clip.inS) * 100) / 100} onCommit={onFreezeLength} /> s
        </label>
      ) : (
        <label className="row">
          Speed <NumberField aria-label="Speed" value={clip.speed} onCommit={onSpeed} /> ×
        </label>
      )}
      <button className="danger" onClick={onDelete}>
        Delete clip
      </button>
    </section>
  );
}
