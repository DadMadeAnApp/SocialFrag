import { useEffect, useRef, useState } from 'react';
import type { Backend, CacheInfo } from '../backend/types';

const GB = 1024 ** 3;
const fmt = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SettingsDialog({ backend, keep, onClose }: { backend: Backend; keep: string[]; onClose: () => void }) {
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const [cap, setCap] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const capInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void backend.cacheInfo().then(
      (i) => {
        setInfo(i);
        setCap(String(i.capGb));
      },
      (e) => setError(messageOf(e)),
    );
  }, [backend]);

  useEffect(() => {
    capInputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function saveCap() {
    const gb = Number(cap);
    if (!Number.isFinite(gb) || gb < 1 || gb > 500) {
      setError('Enter 1 to 500 GB.');
      return;
    }
    if (gb === info?.capGb) {
      setError(null);
      return;
    }
    try {
      const i = await backend.setCacheCap(gb, keep);
      setInfo(i);
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const i = await backend.clearCache(keep);
      setInfo(i);
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <section className="settings" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <h3>Preview cache</h3>
        <p>{info ? `${fmt(info.bytes)} used of ${info.capGb} GB` : 'Checking cache size'}</p>
        <p className="hint">Preview copies and audio for clips you've opened. The oldest clips are removed when the cache is over the limit. Exports are never affected.</p>
        <label>
          Cache limit (GB)
          <input
            ref={capInputRef}
            type="number"
            min={1}
            max={500}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => void saveCap()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveCap();
            }}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="settings-actions">
          <button onClick={() => void clear()} disabled={busy}>Clear cache</button>
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
