export function parseFps(fps: string): number {
  const [n, d] = fps.split('/').map(Number);
  const v = d === undefined ? n : n / d;
  return Number.isFinite(v) && v > 0 ? v : 60;
}

export function formatTime(s: number): string {
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}
