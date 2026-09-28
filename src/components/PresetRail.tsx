import type { Preset } from '../types';

interface Props {
  presets: Preset[];
  selectedId: string;
  warnings: string[];
  onSelect(id: string): void;
  onNew(): void;
  onEditCopy(p: Preset): void;
  onEdit(p: Preset): void;
  onDelete(id: string): void;
  onImport(): void;
  onExport(p: Preset): void;
  disabledNote?: string;
}

export function PresetRail({ presets, selectedId, warnings, onSelect, onNew, onEditCopy, onEdit, onDelete, onImport, onExport, disabledNote }: Props) {
  const selected = presets.find((p) => p.id === selectedId);
  const disabled = !!disabledNote;
  const body = (
    <>
      <ul className="list">
        {presets.map((p) => (
          <li key={p.id}>
            <button disabled={disabled} aria-pressed={p.id === selectedId} className={p.id === selectedId ? 'selected' : ''} onClick={() => onSelect(p.id)}>
              <span className="preset-format" aria-hidden="true">9:16</span>
              <span className="game">{p.game || 'Custom'}</span> {p.name}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="row wrap">
          {selected.builtin ? (
            <button disabled={disabled} onClick={() => onEditCopy(selected)}>Edit a copy</button>
          ) : (
            <>
              <button disabled={disabled} onClick={() => onEdit(selected)}>Edit</button>
              <button disabled={disabled} className="danger" onClick={() => onDelete(selected.id)}>Delete</button>
            </>
          )}
          <button disabled={disabled} onClick={() => onExport(selected)}>Export .json</button>
        </div>
      )}
      <div className="row wrap">
        <button disabled={disabled} onClick={onNew}>New preset</button>
        <button disabled={disabled} onClick={onImport}>Import .json</button>
      </div>
    </>
  );
  return (
    <nav className="rail" aria-label="Presets">
      <h2>Presets</h2>
      <p className="rail-description">Your game. Your layout.</p>
      {disabledNote && <p className="hint">{disabledNote}</p>}
      {disabledNote ? (
        <fieldset className="rail-body" disabled>
          {body}
        </fieldset>
      ) : (
        <div className="rail-body">{body}</div>
      )}
      {warnings.length > 0 && (
        <ul className="warnings" aria-label="Preset warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </nav>
  );
}
