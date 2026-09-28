import { useEffect, useRef, useState } from 'react';
import type { Backend } from '../backend/types';
import type { LaidClip, MediaRef } from '../timeline/model';

/** One thumbnail per clip at its in point, on whole seconds so trimming reuses cached frames. */
export function useThumbnails(backend: Backend, laid: LaidClip[], media: Map<string, MediaRef>) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const { clip } of laid) {
      const m = media.get(clip.mediaId);
      if (!m) continue;
      const at = Math.floor(clip.inS);
      const key = `${m.id}@${at}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      backend.thumbnail(m.path, at).then(
        (p) => setUrls((u) => ({ ...u, [key]: backend.videoUrl(p) })),
        () => {}, // a missing thumbnail just leaves the clip plain
      );
    }
  }, [backend, laid, media]);
  return (mediaId: string, inS: number): string | null => urls[`${mediaId}@${Math.floor(inS)}`] ?? null;
}
