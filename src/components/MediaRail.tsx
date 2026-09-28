import type { MediaStatus } from '../state/useMedia';
import { baseName } from '../state/paths';
import { formatTime } from '../state/trim';
import type { MediaRef } from '../timeline/model';
import type { ClipInfo } from '../types';

interface Props {
  media: MediaRef[];
  status: Record<string, MediaStatus>;
  onAdd(): void;
  onAppend(mediaId: string): void;
  /** Pointer pressed on an item: the timeline takes the drop on release (HTML5 drag-and-drop is off on Windows). */
  onDragStart(mediaId: string): void;
}

export function mediaStatusText(info: ClipInfo, s: MediaStatus | undefined): string | null {
  if (!s) return null;
  if (s.proxyProgress !== null) return `Preparing preview ${Math.round(s.proxyProgress * 100)}%`;
  if (s.audioError) return 'Audio preview unavailable';
  if (info.audioTracks.length && !s.prepared) return 'Preparing audio…';
  return null;
}

export function MediaRail({ media, status, onAdd, onAppend, onDragStart }: Props) {
  return (
    <nav className="rail" aria-label="Media">
      <h2>Media</h2>
      <p className="rail-description">Drag a clip onto the timeline.</p>
      <ul className="list">
        {media.map((m) => {
          const note = mediaStatusText(m.info, status[m.id]);
          const name = baseName(m.path);
          return (
            <li
              key={m.id}
              className="media-item"
              onPointerDown={(e) => {
                e.preventDefault();
                onDragStart(m.id);
              }}
            >
              <span className="media-name">{name}</span>
              <span className="media-meta">{formatTime(m.info.duration)}</span>
              {note && <span className="media-meta">{note}</span>}
              <button aria-label={`Add ${name} to the timeline`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onAppend(m.id)}>
                +
              </button>
            </li>
          );
        })}
      </ul>
      <button onClick={onAdd}>Import clips</button>
    </nav>
  );
}
