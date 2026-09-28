import { useCallback, useMemo, useRef, useState } from 'react';
import type { Backend, PreparedTrack } from '../backend/types';
import type { MediaRef } from '../timeline/model';
import type { ClipInfo } from '../types';
import { baseName } from './paths';
import { webviewCanPlay } from './playback';

export const AUDIO_UNAVAILABLE = 'Audio preview unavailable : export still uses your mix.';

export interface MediaStatus {
  /** What the player loads: the source, or its H.264 proxy once made. */
  url: string;
  proxied: boolean;
  /** 0..1 while the proxy encodes, else null. */
  proxyProgress: number | null;
  prepared: PreparedTrack[] | null;
  audioError: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs jobs one after another: a second ffmpeg reading the same disk only slows both down. */
function serialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return (job: () => Promise<void>) => {
    tail = tail.then(job, job);
  };
}

/** Every imported file: its preview URL (source or proxy), proxy progress and preview audio. */
export function useMedia(backend: Backend, onAudioFailed: (mediaId: string) => void, onError: (message: string) => void) {
  const [status, setStatus] = useState<Record<string, MediaStatus>>({});
  const statusRef = useRef(status);
  statusRef.current = status;
  const callbacks = useRef({ onAudioFailed, onError });
  callbacks.current = { onAudioFailed, onError };
  const refs = useRef(new Map<string, MediaRef>());
  const proxyAsked = useRef(new Set<string>());
  const proxyQueue = useMemo(serialQueue, []);
  const audioQueue = useMemo(serialQueue, []);
  const keep = () => [...refs.current.values()].map((m) => m.path);

  const patch = useCallback((id: string, p: Partial<MediaStatus>) => setStatus((s) => (s[id] ? { ...s, [id]: { ...s[id], ...p } } : s)), []);

  const makeProxy = useCallback(
    (m: MediaRef) => {
      if (proxyAsked.current.has(m.id)) return;
      proxyAsked.current.add(m.id);
      patch(m.id, { proxyProgress: 0 });
      proxyQueue(async () => {
        try {
          const proxy = await backend.makeProxy(m.path, m.info.duration, keep(), (f) => patch(m.id, { proxyProgress: f }));
          patch(m.id, { url: backend.videoUrl(proxy), proxied: true, proxyProgress: null });
        } catch (e) {
          patch(m.id, { proxyProgress: null });
          callbacks.current.onError(`Preview failed: ${message(e)}`);
        }
      });
    },
    [backend, patch, proxyQueue],
  );

  const importPaths = useCallback(
    async (paths: string[]): Promise<MediaRef[]> => {
      const sorted = [...paths].sort((a, b) => baseName(a).localeCompare(baseName(b), undefined, { numeric: true }));
      const out: MediaRef[] = [];
      const fresh: MediaRef[] = [];
      for (const path of sorted) {
        const known = [...refs.current.values()].find((m) => m.path === path);
        if (known) {
          out.push(known);
          continue;
        }
        let info: ClipInfo;
        try {
          info = await backend.probe(path);
        } catch (e) {
          callbacks.current.onError(`${baseName(path)}: ${message(e)}`);
          continue;
        }
        const m: MediaRef = { id: crypto.randomUUID(), path, info };
        refs.current.set(m.id, m);
        setStatus((s) => ({ ...s, [m.id]: { url: backend.videoUrl(path), proxied: false, proxyProgress: null, prepared: null, audioError: null } }));
        out.push(m);
        fresh.push(m);
      }
      // Queued after the whole batch is known, so every job's keep list covers all of it.
      for (const m of fresh) {
        // Silent-failure codecs (e.g. OBS hev1 HEVC in WebKit) never fire an error: go straight to the proxy.
        if (!webviewCanPlay(m.info, (t) => document.createElement('video').canPlayType(t))) makeProxy(m);
        if (!m.info.audioTracks.length) continue;
        audioQueue(async () => {
          try {
            patch(m.id, { prepared: await backend.prepareAudio(m.path, keep()) });
          } catch {
            patch(m.id, { audioError: AUDIO_UNAVAILABLE });
            callbacks.current.onAudioFailed(m.id);
          }
        });
      }
      return out;
    },
    [backend, makeProxy, patch, audioQueue],
  );

  const onPlaybackError = useCallback(
    (mediaId: string) => {
      const s = statusRef.current[mediaId];
      const m = refs.current.get(mediaId);
      if (!s || !m) return;
      if (s.proxied) callbacks.current.onError("This video can't be previewed.");
      else makeProxy(m);
    },
    [makeProxy],
  );

  const mediaIdForUrl = useCallback((url: string) => Object.entries(statusRef.current).find(([, s]) => s.url === url)?.[0] ?? null, []);
  const paths = useMemo(() => Object.keys(status).map((id) => refs.current.get(id)?.path ?? ''), [status]);

  return { status, importPaths, onPlaybackError, mediaIdForUrl, paths };
}
