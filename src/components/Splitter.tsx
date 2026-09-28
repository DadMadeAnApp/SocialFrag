import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface Props {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  /** +1 when dragging right/down grows the value, −1 when it shrinks it. */
  direction: 1 | -1;
  onChange(v: number): void;
  onReset(): void;
}

const STEP = 16;

/** Draggable divider: pointer drag, arrow keys (Shift = ×4), double-click resets. */
export function Splitter({ orientation, label, value, min, max, direction, onChange, onReset }: Props) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const coord = (e: PointerEvent) => (orientation === 'vertical' ? e.clientX : e.clientY);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { pos: coord(e), value };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(clamp(start.current.value + direction * (coord(e) - start.current.pos)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = orientation === 'vertical' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
    const d = grow[e.key as keyof typeof grow];
    if (d === undefined) return;
    e.preventDefault();
    onChange(clamp(value + direction * d * STEP * (e.shiftKey ? 4 : 1)));
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      className={`splitter ${orientation}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => (start.current = null)}
      onDoubleClick={onReset}
      onKeyDown={onKey}
    />
  );
}
