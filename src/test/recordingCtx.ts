/** Fake 2D context: records calls and property sets; measureText = 10px per character. */
export function recordingCtx() {
  const calls: { name: string; args: unknown[] }[] = [];
  const props: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_t, key: string | symbol) => {
        const name = String(key);
        if (name in props) return props[name];
        if (name === 'measureText') return (s: string) => ({ width: s.length * 10 });
        return (...args: unknown[]) => {
          calls.push({ name, args });
        };
      },
      set: (_t, key: string | symbol, value: unknown) => {
        props[String(key)] = value;
        calls.push({ name: `set:${String(key)}`, args: [value] });
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, named: (n: string) => calls.filter((c) => c.name === n).map((c) => c.args) };
}
