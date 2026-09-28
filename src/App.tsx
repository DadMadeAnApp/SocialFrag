import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioPreview } from './audio/AudioPreview';
import { mergePresetAudio, resolveMix } from './audio/resolveMix';
import type { Backend, PreparedTrack, TranscribeItem } from './backend/types';
import { groupWords } from './captions/group';
import { AudioLanes } from './components/AudioLanes';
import { AudioMixer } from './components/AudioMixer';
import { AutoCaptionDialog } from './components/AutoCaptionDialog';
import { CaptionTool } from './components/CaptionTool';
import { ClipInspector } from './components/ClipInspector';
import { ExportPanel } from './components/ExportPanel';
import { HudPanel } from './components/HudPanel';
import { MediaRail } from './components/MediaRail';
import { PresetEditor } from './components/PresetEditor';
import { PresetRail } from './components/PresetRail';
import { PreviewCanvas } from './components/PreviewCanvas';
import { SettingsDialog } from './components/SettingsDialog';
import { Splitter } from './components/Splitter';
import { Timeline } from './components/Timeline';
import { useEditorKeys, type EditorKeyHandlers } from './components/useEditorKeys';
import { BUILTIN_PRESETS, blankPreset, duplicatePreset, fullFramePreset, loadUserPresets } from './presets/presets';
import { validatePreset } from './presets/validate';
import { editCaption, removeCaption, updateCaption } from './state/captions';
import { COLLAPSED_W, DEFAULT_LAYOUT, LIMITS, loadLayout, safeStorage, saveLayout, type PanelLayout } from './state/layout';
import { baseName } from './state/paths';
import { AUDIO_UNAVAILABLE, useMedia } from './state/useMedia';
import { useThumbnails } from './state/useThumbnails';
import { makeCurveCache } from './timeline/curves';
import { clipAt, emptyProject, layoutClips, sourceTimeAt, type TimelineClip } from './timeline/model';
import {
  addMedia, applyPreset, applyPresetToClip, applyTranscription, insertClips, insertFreeze, mergeCaptionWithNext, moveClip, newClip, rippleDelete, setFormat, setFreezeLength, setSpeed, setTrackStyle, splitAt, splitCaption, trimClip, updateClip,
} from './timeline/ops';
import { TimelinePlayer, type PlayerClip } from './timeline/player';
import { audioSegments } from './timeline/segments';
import { useHistory } from './timeline/useHistory';
import type { AudioMix, Caption, Layer, Preset } from './types';
import { formatOf } from './types';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_ENVELOPES = new Map<number, Float32Array>();
const uuid = () => crypto.randomUUID();
const ALL_PARTS = { layers: true, audio: true };

export function App({ backend }: { backend: Backend }) {
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [userPresets, setUserPresets] = useState<Preset[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  /** Preset for newly added clips: the last one picked in the rail. */
  const [lastPresetId, setLastPresetId] = useState(BUILTIN_PRESETS[0].id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Preset | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [autoCaption, setAutoCaption] = useState<null | 'timeline' | 'clip'>(null);
  const [railTab, setRailTab] = useState<'media' | 'presets'>('presets');
  const [previewAudioError, setPreviewAudioError] = useState<string | null>(null);
  const [mediaDrag, setMediaDrag] = useState<string | null>(null);
  const history = useHistory(emptyProject);
  const project = history.present;
  const edit = history.set;
  const replace = history.replace;
  const rewriteHistory = history.rewrite;

  const allPresets = useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets]);
  const presetById = useCallback((id: string) => allPresets.find((p) => p.id === id) ?? BUILTIN_PRESETS[0], [allPresets]);
  // importPaths reads this instead of depending on the preset, so switching presets doesn't tear down and
  // re-register the (async) onFileDrop listener and drop a file dragged in that gap.
  const lastPresetRef = useRef(presetById(lastPresetId));
  useEffect(() => {
    lastPresetRef.current = presetById(lastPresetId);
  }, [presetById, lastPresetId]);

  const refreshPresets = useCallback(async () => {
    const loaded = loadUserPresets(await backend.listUserPresets());
    setUserPresets(loaded.presets);
    setWarnings(loaded.warnings);
  }, [backend]);
  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  const onAudioFailed = useCallback(
    (mediaId: string) =>
      // Ducking needs envelopes from prepareAudio; without them the export has no duck curve, so match the UI.
      // Rewrites the whole undo history so an earlier undo can't bring the duck back on media whose audio failed.
      rewriteHistory((p) => ({ ...p, main: p.main.map((c) => (c.mediaId === mediaId && c.mix.duck ? { ...c, mix: { ...c.mix, duck: null } } : c)) })),
    [rewriteHistory],
  );
  const media = useMedia(backend, onAudioFailed, setError);
  const mediaById = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);
  const laid = useMemo(() => layoutClips(project.main), [project.main]);
  const selected = project.main.find((c) => c.id === selectedId) ?? null;
  const selectedMedia = selected ? (mediaById.get(selected.mediaId) ?? null) : null;
  const durationOf = (c: TimelineClip) => mediaById.get(c.mediaId)?.info.duration ?? 0;
  const tracksOf = (c: TimelineClip) => mediaById.get(c.mediaId)?.info.audioTracks ?? [];

  // --- playback: two hidden video elements driven by the timeline player
  const [elA, setElA] = useState<HTMLVideoElement | null>(null);
  const [elB, setElB] = useState<HTMLVideoElement | null>(null);
  const [player, setPlayer] = useState<TimelinePlayer | null>(null);
  useEffect(() => {
    if (!elA || !elB) return;
    const p = new TimelinePlayer(elA, elB);
    setPlayer(p);
    return () => {
      p.dispose();
      setPlayer(null);
    };
  }, [elA, elB]);
  const [active, setActive] = useState<{ index: number; el: HTMLVideoElement | null }>({ index: -1, el: null });
  const { onPlaybackError, mediaIdForUrl } = media;
  useEffect(() => {
    if (!player) return;
    const onClip = () => setActive({ index: player.clipIndex, el: player.activeElement as HTMLVideoElement });
    const onMediaError = (e: Event) => {
      const id = mediaIdForUrl((e as CustomEvent<string>).detail);
      if (id) onPlaybackError(id);
    };
    player.addEventListener('clipchange', onClip);
    player.addEventListener('mediaerror', onMediaError);
    let raf = 0;
    const tick = () => {
      player.tick();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      player.removeEventListener('clipchange', onClip);
      player.removeEventListener('mediaerror', onMediaError);
      cancelAnimationFrame(raf);
    };
  }, [player, onPlaybackError, mediaIdForUrl]);
  const playerClips = useMemo<PlayerClip[]>(
    () => laid.map((e) => ({ id: e.clip.id, kind: e.clip.kind, url: media.status[e.clip.mediaId]?.url ?? '', inS: e.clip.inS, startS: e.startS, durS: e.durS, speed: e.clip.speed })),
    [laid, media.status],
  );
  const playerKey = JSON.stringify(playerClips);
  useEffect(() => {
    player?.setClips(playerClips);
    // playerKey (not playerClips) is the intended dependency: proxy progress rebuilds the array without changing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, playerKey]);
  const activeEntry = laid[active.index] ?? null;
  const activeMedia = activeEntry ? (mediaById.get(activeEntry.clip.mediaId) ?? null) : null;
  const activeVideo = activeEntry ? active.el : null;
  const now = () => player?.currentTime ?? 0;

  // --- preview audio: one segment per clip per enabled track
  const envCache = useRef(new WeakMap<PreparedTrack[], Map<number, Float32Array>>());
  const envelopesOf = useCallback(
    (mediaId: string) => {
      const prepared = media.status[mediaId]?.prepared;
      if (!prepared) return null;
      let m = envCache.current.get(prepared);
      if (!m) {
        m = new Map(prepared.map((t) => [t.index, t.envelope]));
        envCache.current.set(prepared, m);
      }
      return m;
    },
    [media.status],
  );
  const curveCache = useMemo(() => makeCurveCache(), []);
  const curvesOf = useCallback((c: TimelineClip) => curveCache(c, mediaById.get(c.mediaId)?.info.duration ?? 0, envelopesOf(c.mediaId)), [curveCache, mediaById, envelopesOf]);
  const [audioPreview, setAudioPreview] = useState<AudioPreview | null>(null);
  useEffect(() => {
    if (!player) return;
    let p: AudioPreview;
    try {
      p = new AudioPreview(player, (path, start, frames) => backend.readPcm(path, start, frames), undefined, () => setPreviewAudioError(AUDIO_UNAVAILABLE));
    } catch {
      setPreviewAudioError(AUDIO_UNAVAILABLE);
      return;
    }
    setAudioPreview(p);
    return () => {
      p.dispose();
      setAudioPreview(null);
    };
  }, [player, backend]);
  useEffect(() => {
    audioPreview?.setSegments(audioSegments(laid, (id) => media.status[id]?.prepared ?? null, (c) => curvesOf(c).timeline));
  }, [audioPreview, laid, media.status, curvesOf]);

  // --- importing
  const selectClip = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedCaptionId(null);
  }, []);
  const importMedia = media.importPaths;
  const importPaths = useCallback(
    async (paths: string[], at?: number) => {
      if (!paths.length) return;
      setError(null);
      setBusy('Opening clip');
      try {
        const refs = await importMedia(paths);
        if (!refs.length) return;
        const clips = refs.map((m) => newClip(uuid(), m, lastPresetRef.current));
        edit((p) => insertClips(addMedia(p, refs), at ?? p.main.length, clips));
        selectClip(clips[0].id);
      } finally {
        setBusy(null);
      }
    },
    [importMedia, edit, selectClip],
  );
  useEffect(() => backend.onFileDrop((paths) => void importPaths(paths)), [backend, importPaths]);
  async function addClips() {
    await importPaths(await backend.pickClips());
  }
  function appendMedia(mediaId: string, at?: number) {
    const m = mediaById.get(mediaId);
    if (!m) return;
    const c = newClip(uuid(), m, lastPresetRef.current);
    edit((p) => insertClips(p, at ?? p.main.length, [c]));
    selectClip(c.id);
  }
  useEffect(() => {
    if (!mediaDrag) return;
    const end = () => setMediaDrag(null);
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, [mediaDrag]);

  // --- editing
  const setMix = (id: string, mix: AudioMix) => edit((p) => updateClip(p, id, { mix }), `mix:${id}`);
  const setLayer = (id: string, layer: Layer, key: string | null) =>
    edit((p) => updateClip(p, id, { layers: (p.main.find((c) => c.id === id)?.layers ?? []).map((l) => (l.id === layer.id ? layer : l)) }), key);
  const setCaptions = (id: string, captions: Caption[]) => edit((p) => updateClip(p, id, { captions }), `captions:${id}`);
  function trimAtPlayhead(edge: 'in' | 'out') {
    const t = now();
    const e = clipAt(laid, t);
    if (!e || e.clip.kind !== 'video') return;
    edit((p) => trimClip(p, e.clip.id, edge, sourceTimeAt(e, t), durationOf(e.clip)));
    if (edge === 'in' && player) player.currentTime = e.startS;
  }
  // A selection whose caption no longer exists (re-run, undo) falls back to the clip.
  const liveCaptionId = selectedCaptionId && selected?.captions.some((c) => c.id === selectedCaptionId) ? selectedCaptionId : null;
  const editor: EditorKeyHandlers = {
    togglePlay: () => {
      if (!player) return;
      if (player.paused) void player.play();
      else player.pause();
    },
    split: () => {
      const e = liveCaptionId ? laid.find((x) => x.clip.id === selectedId) : undefined;
      if (e && liveCaptionId) edit((p) => splitCaption(p, e.clip.id, liveCaptionId, sourceTimeAt(e, now()), uuid()));
      else edit((p) => splitAt(p, now(), uuid()));
    },
    remove: () => {
      if (!selectedId) return;
      if (liveCaptionId) {
        const id = liveCaptionId;
        edit((p) => updateClip(p, selectedId, { captions: removeCaption(p.main.find((c) => c.id === selectedId)?.captions ?? [], id) }));
        setSelectedCaptionId(null);
        return;
      }
      edit((p) => rippleDelete(p, selectedId));
      selectClip(null);
    },
    freeze: () => edit((p) => insertFreeze(p, now(), uuid(), uuid())),
    setIn: () => trimAtPlayhead('in'),
    setOut: () => trimAtPlayhead('out'),
    step: (dir) => {
      if (!player) return;
      player.pause();
      player.currentTime = now() + dir / project.fps;
    },
    undo: history.undo,
    redo: history.redo,
  };
  useEditorKeys(editor, draft === null && autoCaption === null && project.main.length > 0);

  const onCaptionChange = (c: Caption) => {
    if (!activeEntry) return;
    const prev = activeEntry.clip.captions.find((x) => x.id === c.id);
    setCaptions(activeEntry.clip.id, updateCaption(activeEntry.clip.captions, prev ? editCaption(prev, c) : c));
  };
  // --- auto-captions
  const captionScope = (scope: 'timeline' | 'clip') => project.main.filter((c) => c.kind === 'video' && (scope === 'timeline' || c.id === selectedId));
  const captionTracks = (scope: 'timeline' | 'clip') => {
    const out: { label: string; env?: Float32Array }[] = [];
    for (const c of captionScope(scope)) {
      for (const t of mediaById.get(c.mediaId)?.info.audioTracks ?? []) {
        const env = media.status[c.mediaId]?.prepared?.find((x) => x.index === t.index)?.envelope;
        const known = out.find((x) => x.label === t.label);
        if (!known) out.push({ label: t.label, env });
        else if (!known.env && env) known.env = env;
      }
    }
    return out;
  };
  const captionItems = (scope: 'timeline' | 'clip', labels: string[]): TranscribeItem[] =>
    captionScope(scope).flatMap((c) => {
      const m = mediaById.get(c.mediaId);
      return (m?.info.audioTracks ?? []).filter((t) => labels.includes(t.label)).map((t) => ({ key: `${c.id}:${t.index}`, source: m!.path, track: t.index, inS: c.inS, outS: c.outS }));
    });
  const trackLabel = (c: TimelineClip, index: number) => mediaById.get(c.mediaId)?.info.audioTracks.find((t) => t.index === index)?.label ?? `Track ${index + 1}`;
  const onSelectCaption = (id: string | null) => {
    setSelectedCaptionId(id);
    if (id && activeEntry) setSelectedId(activeEntry.clip.id);
  };
  const onLayerChange = (layer: Layer) => {
    const c = activeEntry?.clip;
    if (!c) return;
    setSelectedId(c.id);
    setLayer(c.id, layer, `layers:${c.id}`);
  };

  // --- presets
  /**
   * After saving `saved` (previously `old`), clips on it pick up whichever half changed; clips in
   * `switchIds` move onto it, taking `switchParts`.
   */
  function applySaved(saved: Preset, old: Preset | undefined, switchIds: string[], switchParts = ALL_PARTS) {
    const layersChanged = !old || JSON.stringify(old.layers) !== JSON.stringify(saved.layers);
    const audioChanged = !old || JSON.stringify(old.audio ?? null) !== JSON.stringify(saved.audio ?? null);
    if (!switchIds.length && !layersChanged && !audioChanged) return;
    edit((p) => ({
      ...p,
      main: p.main.map((c) => {
        if (switchIds.includes(c.id) && c.presetId !== saved.id) return applyPresetToClip(c, tracksOf(c), saved, switchParts);
        if (c.presetId !== saved.id || (!layersChanged && !audioChanged)) return c;
        return applyPresetToClip(c, tracksOf(c), saved, { layers: layersChanged, audio: audioChanged });
      }),
    }));
  }
  function selectPreset(p: Preset) {
    setLastPresetId(p.id);
    if (selected && selected.presetId !== p.id) edit((x) => applyPreset(x, [selected.id], p));
  }
  const openEditor = (p: Preset) => {
    if (!activeEntry) {
      setError('Open a clip first so the editor has a frame to show.');
      return;
    }
    setDraft(p);
  };
  async function saveDraft() {
    if (!draft) return;
    const r = validatePreset(draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const old = allPresets.find((p) => p.id === r.preset.id);
    try {
      await backend.savePreset(r.preset);
    } catch (e) {
      setError(message(e));
      return;
    }
    await refreshPresets();
    setLastPresetId(r.preset.id);
    applySaved(r.preset, old, selectedId ? [selectedId] : []);
    setDraft(null);
  }
  async function deletePreset(id: string) {
    await backend.deletePreset(id);
    if (lastPresetId === id) setLastPresetId(BUILTIN_PRESETS[0].id);
    // Not an undo step: the preset is gone, so undo must not point clips back at it.
    if (project.main.some((c) => c.presetId === id)) replace((p) => ({ ...p, main: p.main.map((c) => (c.presetId === id ? { ...c, presetId: BUILTIN_PRESETS[0].id } : c)) }));
    await refreshPresets();
  }
  async function importPreset() {
    const text = await backend.importPreset();
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setError('Import failed: not a JSON file.');
      return;
    }
    const r = validatePreset(raw);
    if (!r.ok) {
      setError(`Import failed: ${r.error}`);
      return;
    }
    const p = { ...r.preset, id: uuid(), builtin: false };
    try {
      await backend.savePreset(p);
    } catch (e) {
      setError(message(e));
      return;
    }
    await refreshPresets();
    selectPreset(p);
  }
  async function savePresetFrom(target: Preset, old: Preset | undefined, parts: { layers: boolean; audio: boolean }) {
    if (!selected) return;
    const r = validatePreset(target);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    try {
      await backend.savePreset(r.preset);
      await refreshPresets();
      setLastPresetId(r.preset.id);
      applySaved(r.preset, old, [selected.id], parts);
    } catch (e) {
      setError(message(e));
    }
  }
  function saveMixToPreset() {
    if (!selected) return;
    const base = presetById(selected.presetId);
    const audio = mergePresetAudio(base.audio, selected.mix);
    void savePresetFrom(base.builtin ? { ...duplicatePreset(base, uuid()), audio } : { ...base, audio }, base.builtin ? undefined : base, { layers: false, audio: true });
  }
  function saveLayoutToPreset() {
    if (!selected) return;
    const base = presetById(selected.presetId);
    const withLayers = { ...base, layers: selected.layers };
    void savePresetFrom(base.builtin ? duplicatePreset(withLayers, uuid()) : withLayers, base.builtin ? undefined : base, { layers: true, audio: false });
  }

  // --- derived UI state
  const thumbAt = useThumbnails(backend, laid, mediaById);
  const status = selected ? media.status[selected.mediaId] : undefined;
  const audioNotice = selected && selectedMedia ? resolveMix(selectedMedia.info.audioTracks, presetById(selected.presetId)).notice : null;
  const blockedReason = project.main.some((c) => c.kind === 'video' && c.mix.duck && !media.status[c.mediaId]?.prepared && !media.status[c.mediaId]?.audioError) ? 'Preparing audio' : null;
  const proxying = Object.values(media.status).find((s) => s.proxyProgress !== null) ?? null;
  const notice = busy ?? (proxying ? 'Preparing preview' : null);
  const hasClips = project.main.length > 0;
  const format = formatOf(project.canvas);
  const sessionName = !hasClips ? 'Your next highlight starts here' : project.main.length === 1 ? baseName(mediaById.get(project.main[0].mediaId)?.path ?? '') : `${project.main.length} clips`;
  const selectedIsActive = !!selected && activeEntry?.clip.id === selected.id;

  const [winH, setWinH] = useState(() => window.innerHeight);
  const [layout, setLayout] = useState<PanelLayout>(() => loadLayout(safeStorage(), window.innerHeight));
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => saveLayout(safeStorage(), layout), [layout]);
  const patchLayout = (p: Partial<PanelLayout>) => setLayout((l) => ({ ...l, ...p }));
  const timelineMax = Math.max(LIMITS.timelineMin, winH * LIMITS.timelineMaxFrac);
  const timelineH = Math.min(layout.timelineH, timelineMax);
  const showSide = hasClips && draft === null;
  const railCol = layout.railCollapsed ? `${COLLAPSED_W}px` : `${layout.railW}px 6px`;
  const sideCol = !showSide ? '' : layout.sideCollapsed ? `${COLLAPSED_W}px` : `6px ${layout.sideW}px`;

  return (
    <div className="workspace">
      <header className="app-header">
        <div className="brand">
          SocialFrag<span className="brand-slash" aria-hidden="true">/</span>
        </div>
        <span className="workspace-label">CLIP STUDIO</span>
        <div className="session-name">{sessionName}</div>
        <fieldset className="format-switch" disabled={exporting || draft !== null}>
          <legend className="sr-only">Format</legend>
          {(['vertical', 'landscape'] as const).map((f) => (
            <label key={f} className={format === f ? 'selected' : ''}>
              <input type="radio" name="format" disabled={exporting || draft !== null} checked={format === f} onChange={() => edit((p) => setFormat(p, f))} />
              {f === 'vertical' ? '9:16 Vertical' : '16:9 Landscape'}
            </label>
          ))}
        </fieldset>
        <button className="link" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>
      <div className="app" style={{ gridTemplateColumns: `${railCol} minmax(0, 1fr) ${sideCol}` }}>
        {layout.railCollapsed ? (
          <div className="collapsed-strip">
            <button aria-label="Show library" onClick={() => patchLayout({ railCollapsed: false })}>
              »
            </button>
          </div>
        ) : (
          <>
            <div className="pane">
              <button className="collapse" aria-label="Hide library" onClick={() => patchLayout({ railCollapsed: true })}>
                «
              </button>
              <div className="rail-stack">
                <div className="rail-tabs" role="tablist" aria-label="Library">
                  <button role="tab" aria-selected={railTab === 'media'} className={railTab === 'media' ? 'selected' : ''} onClick={() => setRailTab('media')}>
                    Media
                  </button>
                  <button role="tab" aria-selected={railTab === 'presets'} className={railTab === 'presets' ? 'selected' : ''} onClick={() => setRailTab('presets')}>
                    Presets
                  </button>
                </div>
                {railTab === 'presets' ? (
                  <PresetRail
                    presets={allPresets}
                    selectedId={selected?.presetId ?? lastPresetId}
                    warnings={warnings}
                    disabledNote={format === 'landscape' ? 'Presets shape vertical exports. Switch to 9:16 to use them.' : undefined}
                    onSelect={(id) => selectPreset(presetById(id))}
                    onNew={() => openEditor(blankPreset(uuid()))}
                    onEditCopy={(p) => openEditor(duplicatePreset(p, uuid()))}
                    onEdit={(p) => openEditor(structuredClone(p))}
                    onDelete={(id) => void deletePreset(id)}
                    onImport={() => void importPreset()}
                    onExport={(p) => void backend.exportPreset(p)}
                  />
                ) : (
                  <MediaRail media={project.media} status={media.status} onAdd={() => void addClips()} onAppend={(id) => appendMedia(id)} onDragStart={setMediaDrag} />
                )}
              </div>
            </div>
            <Splitter orientation="vertical" label="Resize library" value={layout.railW} min={LIMITS.railW[0]} max={LIMITS.railW[1]} direction={1} onChange={(v) => patchLayout({ railW: v })} onReset={() => patchLayout({ railW: DEFAULT_LAYOUT.railW })} />
          </>
        )}
        <main className={`stage${hasClips ? '' : ' empty'}`}>
          <video ref={setElA} className="source-video player-a" preload="auto" />
          <video ref={setElB} className="source-video player-b" preload="auto" />
          {hasClips ? (
            draft && activeMedia ? (
              <PresetEditor video={activeVideo} info={activeMedia.info} preset={draft} onChange={setDraft} onSave={() => void saveDraft()} onCancel={() => setDraft(null)} />
            ) : (
              <div className="stage-body" style={{ gridTemplateRows: `minmax(0, 1fr) 6px ${timelineH}px` }}>
                <div className="preview-box">
                  {activeEntry && activeMedia && (
                    <PreviewCanvas
                      video={activeVideo}
                      info={activeMedia.info}
                      preset={format === 'landscape' ? fullFramePreset(project.canvas) : { ...presetById(activeEntry.clip.presetId), layers: activeEntry.clip.layers }}
                      canvas={project.canvas}
                      captions={activeEntry.clip.captions}
                      selectedCaptionId={selectedCaptionId}
                      onSelectCaption={onSelectCaption}
                      onCaptionChange={onCaptionChange}
                      onLayerChange={onLayerChange}
                    />
                  )}
                </div>
                <Splitter orientation="horizontal" label="Resize timeline" value={timelineH} min={LIMITS.timelineMin} max={timelineMax} direction={-1} onChange={(v) => patchLayout({ timelineH: v })} onReset={() => patchLayout({ timelineH: DEFAULT_LAYOUT.timelineH })} />
                <div className="timeline">
                  <Timeline
                    player={player}
                    laid={laid}
                    nameOf={(id) => baseName(mediaById.get(id)?.path ?? '')}
                    thumbOf={(c) => thumbAt(c.mediaId, c.inS)}
                    selectedId={selectedId}
                    draggingMediaId={mediaDrag}
                    onSelect={selectClip}
                    onTrim={(id, edge, srcT) => {
                      const c = project.main.find((x) => x.id === id);
                      if (c) edit((p) => trimClip(p, id, edge, srcT, durationOf(c)), `trim:${id}:${edge}`);
                    }}
                    onFreezeLength={(id, s) => edit((p) => setFreezeLength(p, id, s), `hold:${id}`)}
                    onMove={(id, i) => edit((p) => moveClip(p, id, i))}
                    onDropMedia={(id, i) => appendMedia(id, i)}
                    onAdd={() => void addClips()}
                    tools={{ ...editor, canUndo: history.canUndo, canRedo: history.canRedo }}
                    captionLane={{
                      selectedCaptionId,
                      onSelect: (clipId, captionId) => {
                        setSelectedId(clipId);
                        setSelectedCaptionId(captionId);
                      },
                      onRetime: (clipId, captionId, start, end) => {
                        const c = project.main.find((x) => x.id === clipId);
                        const prev = c?.captions.find((x) => x.id === captionId);
                        if (c && prev) setCaptions(clipId, updateCaption(c.captions, editCaption(prev, { ...prev, start, end })));
                      },
                    }}
                  />
                  {selected?.kind === 'video' && selectedMedia && (
                    <AudioLanes
                      video={selectedIsActive ? activeVideo : null}
                      info={selectedMedia.info}
                      trim={{ inS: selected.inS, outS: selected.outS }}
                      mix={selected.mix}
                      envelopes={envelopesOf(selected.mediaId) ?? NO_ENVELOPES}
                      onChange={(mix) => setMix(selected.id, mix)}
                    />
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="welcome">
              <p className="welcome-label">GOOD PLAYS DESERVE AN AUDIENCE</p>
              <h1>
                Make the play.
                <br />
                <span>Own the feed.</span>
              </h1>
              <p className="welcome-copy">
                Turn your gameplay into vertical highlights.
                <br />
                Keep the action, the HUD, and your voice.
              </p>
              <div className="dropzone">
                <span className="upload-symbol" aria-hidden="true">
                  ↑
                </span>
                <h2>Drop a clip</h2>
                <p>Drag your gameplay recordings here to get started</p>
                <button className="primary" onClick={() => void addClips()}>
                  Open clip <span aria-hidden="true">↗</span>
                </button>
              </div>
              <div className="workflow" aria-label="Editing workflow">
                <span>
                  <b>01</b> Pick a layout
                </span>
                <span>
                  <b>02</b> Make your cut
                </span>
                <span>
                  <b>03</b> Export your highlight
                </span>
              </div>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              {!busy && proxying && (
                <span className="notice-progress">
                  <progress value={proxying.proxyProgress ?? 0} max={1} aria-label="Preview progress" />
                  <span>{Math.round((proxying.proxyProgress ?? 0) * 100)}%</span>
                </span>
              )}
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error} <button onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
        </main>
        {showSide && !layout.sideCollapsed && (
          <Splitter orientation="vertical" label="Resize sidebar" value={layout.sideW} min={LIMITS.sideW[0]} max={LIMITS.sideW[1]} direction={-1} onChange={(v) => patchLayout({ sideW: v })} onReset={() => patchLayout({ sideW: DEFAULT_LAYOUT.sideW })} />
        )}
        {showSide && layout.sideCollapsed && (
          <div className="collapsed-strip">
            <button aria-label="Show sidebar" onClick={() => patchLayout({ sideCollapsed: false })}>
              «
            </button>
          </div>
        )}
        {hasClips && (
          // Stays mounted while editing presets or collapsed so a running export keeps its progress and Cancel button.
          <aside className="side" hidden={draft !== null || layout.sideCollapsed}>
            <button className="collapse" aria-label="Hide sidebar" onClick={() => patchLayout({ sideCollapsed: true })}>
              »
            </button>
            {selected && selectedMedia ? (
              <>
                <ClipInspector
                  clip={selected}
                  name={baseName(selectedMedia.path)}
                  onSpeed={(s) => edit((p) => setSpeed(p, selected.id, s), `speed:${selected.id}`)}
                  onFreezeLength={(s) => edit((p) => setFreezeLength(p, selected.id, s), `hold:${selected.id}`)}
                  onDelete={() => {
                    edit((p) => rippleDelete(p, selected.id));
                    selectClip(null);
                  }}
                />
                <CaptionTool
                  captions={selected.captions}
                  selectedId={selectedCaptionId}
                  video={selectedIsActive ? activeVideo : null}
                  onChange={(c) => setCaptions(selected.id, c)}
                  onSelect={setSelectedCaptionId}
                  onRun={setAutoCaption}
                  onMerge={(id) => edit((p) => mergeCaptionWithNext(p, selected.id, id))}
                  trackStyles={Object.entries(selected.captionStyles).map(([k, style]) => ({ trackIndex: Number(k), label: trackLabel(selected, Number(k)), style }))}
                  onTrackStyle={(t, st) => edit((p) => setTrackStyle(p, selected.id, t, st), `trackstyle:${selected.id}:${t}`)}
                />
                <HudPanel
                  layers={selected.layers}
                  disabled={format === 'landscape'}
                  onToggle={(l) => setLayer(selected.id, l, null)}
                  onReset={() => edit((p) => updateClip(p, selected.id, { layers: presetById(selected.presetId).layers }))}
                  onSave={saveLayoutToPreset}
                />
                {selected.kind === 'video' && (
                  <AudioMixer
                    mix={selected.mix}
                    notice={audioNotice}
                    previewError={status?.audioError ?? previewAudioError}
                    hasAudio={selectedMedia.info.audioTracks.length > 0}
                    canDuck={!!status?.prepared}
                    onChange={(mix) => setMix(selected.id, mix)}
                    onSaveToPreset={saveMixToPreset}
                  />
                )}
              </>
            ) : (
              <p className="hint">Select a clip on the timeline to edit it.</p>
            )}
            <ExportPanel backend={backend} project={project} presetById={presetById} curves={(c) => curvesOf(c).source} blockedReason={blockedReason} onRunningChange={setExporting} />
          </aside>
        )}
      </div>
      {autoCaption && (
        <AutoCaptionDialog
          backend={backend}
          tracks={captionTracks(autoCaption)}
          scope={autoCaption}
          buildJob={(labels, model) => ({ model, items: captionItems(autoCaption, labels) })}
          onResult={(_job, results) => {
            setSelectedCaptionId(null);
            // One undo step for the whole run: no coalescing key.
            edit((p) =>
              applyTranscription(
                p,
                results.map((r) => {
                  const [clipId, t] = r.key.split(':');
                  return { clipId, trackIndex: Number(t), lines: groupWords(r.words) };
                }),
                uuid,
              ),
            );
          }}
          onClose={() => setAutoCaption(null)}
        />
      )}
      {showSettings && <SettingsDialog backend={backend} keep={media.paths} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
