import { useEffect, useState } from 'react';
import type { Backend, ItemWords, TranscribeJob, WhisperModel, WhisperModelId } from '../backend/types';
import { defaultVoiceTracks, isVoiceSource } from '../captions/defaults';

interface Props {
  backend: Backend;
  /** Audio tracks of the clips in scope, by label; env = RMS envelope when prepared. */
  tracks: { label: string; env?: Float32Array }[];
  scope: 'timeline' | 'clip';
  buildJob(labels: string[], model: WhisperModelId): TranscribeJob;
  onResult(job: TranscribeJob, results: ItemWords[], labels: string[]): void;
  onClose(): void;
}

const MODEL_IDS: WhisperModelId[] = ['base.en', 'small.en', 'medium.en'];

type Run = { kind: 'idle' } | { kind: 'running'; stage: 'Downloading model' | 'Captioning'; fraction: number } | { kind: 'error'; message: string } | { kind: 'empty'; labels: string[] };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Picks tracks and a model, downloads the model on first use, runs whisper with progress and cancel. */
export function AutoCaptionDialog({ backend, tracks, scope, buildJob, onResult, onClose }: Props) {
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [model, setModel] = useState<WhisperModelId>('small.en');
  const [labels, setLabels] = useState<string[]>(() => defaultVoiceTracks(tracks));
  const [run, setRun] = useState<Run>({ kind: 'idle' });

  useEffect(() => {
    void backend.whisperModels().then(setModels, (e) => setRun({ kind: 'error', message: messageOf(e) }));
  }, [backend]);

  const running = run.kind === 'running';
  const toggle = (l: string) => setLabels((xs) => (xs.includes(l) ? xs.filter((x) => x !== l) : [...xs, l]));
  const picked = tracks.map((t) => t.label).filter((l) => labels.includes(l));

  async function start() {
    try {
      if (!models.find((m) => m.id === model)?.downloaded) {
        setRun({ kind: 'running', stage: 'Downloading model', fraction: 0 });
        await backend.downloadWhisperModel(model, (fraction) => setRun({ kind: 'running', stage: 'Downloading model', fraction }));
        setModels((ms) => ms.map((m) => (m.id === model ? { ...m, downloaded: true } : m)));
      }
      setRun({ kind: 'running', stage: 'Captioning', fraction: 0 });
      const job = buildJob(picked, model);
      const { items: results, error } = await backend.transcribe(job, (fraction) => setRun({ kind: 'running', stage: 'Captioning', fraction }));
      // Clips finished before a failure are kept; the error still shows.
      if (results.length) onResult(job, results, picked);
      if (error) {
        setRun({ kind: 'error', message: error });
        return;
      }
      const silent = picked.filter((l) => {
        const keys = new Set(buildJob([l], model).items.map((it) => it.key));
        return keys.size > 0 && results.filter((r) => keys.has(r.key)).every((r) => r.words.length === 0);
      });
      if (silent.length) setRun({ kind: 'empty', labels: silent });
      else onClose();
    } catch (e) {
      const message = messageOf(e);
      setRun(message.includes('cancelled') ? { kind: 'idle' } : { kind: 'error', message });
    }
  }

  return (
    <div className="settings-backdrop">
      <section className="settings" role="dialog" aria-modal="true" aria-label="Auto-caption">
        <h2>Auto-caption {scope === 'clip' ? 'this clip' : 'the whole timeline'}</h2>
        <fieldset disabled={running}>
          <legend>Tracks</legend>
          {tracks.map((t) => (
            <label key={t.label}>
              <input type="checkbox" checked={labels.includes(t.label)} onChange={() => toggle(t.label)} /> {t.label}
            </label>
          ))}
        </fieldset>
        <fieldset disabled={running}>
          <legend>Model</legend>
          {MODEL_IDS.map((id) => {
            const m = models.find((x) => x.id === id);
            return (
              <label key={id}>
                <input type="radio" name="whisper-model" checked={model === id} onChange={() => setModel(id)} /> {id}{' '}
                <span className="hint">
                  {id === 'base.en' ? 'faster, less accurate · ' : ''}
                  {m?.downloaded ? 'Downloaded' : m ? `${Math.round(m.bytes / 1e6)} MB` : ''}
                </span>
              </label>
            );
          })}
        </fieldset>
        {picked.some((l) => !isVoiceSource(l)) && (
          <div className="notice-inline warning" role="note">
            <p>
              <strong>Game audio lowers caption accuracy.</strong> Speech mixed with gunfire, vehicles and music is often missed, mistimed or
              misheard. For best results, record voice on its own track (e.g. Discord or a mic) and caption that track.
            </p>
          </div>
        )}
        {run.kind === 'running' && (
          <div className="progress">
            <progress value={run.fraction} max={1} aria-label={run.stage} />
            <span>
              {run.stage} {Math.round(run.fraction * 100)}%
            </span>
          </div>
        )}
        {run.kind === 'error' && (
          <div className="notice-inline error" role="alert">
            <p>{run.message.split('\n')[0]}</p>
            <button onClick={() => void navigator.clipboard?.writeText(run.message)}>Copy error details</button>
          </div>
        )}
        {run.kind === 'empty' && run.labels.map((l) => <p key={l} className="hint">No speech found on {l}</p>)}
        <div className="row">
          {running ? (
            <button onClick={() => void backend.cancelTranscribe()}>Cancel</button>
          ) : (
            <>
              {run.kind !== 'empty' && (
                <button className="primary" disabled={!picked.length || !models.length} onClick={() => void start()}>
                  Start
                </button>
              )}
              <button onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
