import { isGameplayLayer } from '../editor/geometry';
import type { Layer } from '../types';

interface Props {
  layers: Layer[];
  onToggle(layer: Layer): void;
  onReset(): void;
  onSave(): void;
  disabled?: boolean;
}

/** Sidebar controls for the HUD layers of the working (per-clip) layout: show/hide, reset, and save back to a preset. */
export function HudPanel({ layers, onToggle, onReset, onSave, disabled }: Props) {
  const hudLayers = layers.filter((_, i) => !isGameplayLayer(layers, i));
  return (
    <div className="hud-panel">
      <h2>HUD</h2>
      <fieldset disabled={disabled}>
        <ul className="list">
          {hudLayers.map((l) => (
            <li key={l.id} className="row">
              <label>
                <input type="checkbox" disabled={disabled} aria-label={`Show ${l.label}`} checked={!l.hidden} onChange={() => onToggle({ ...l, hidden: !l.hidden })} />
                {l.label}
              </label>
            </li>
          ))}
        </ul>
        <div className="row">
          <button disabled={disabled} onClick={onReset}>Reset to preset</button>
          <button disabled={disabled} onClick={onSave}>Save layout to preset</button>
        </div>
      </fieldset>
    </div>
  );
}
