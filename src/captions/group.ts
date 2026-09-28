export interface Word { text: string; startS: number; endS: number }
export interface Line { text: string; start: number; end: number }

/** Whisper words → caption lines: at most maxWords words and maxS seconds, broken at silences over gapS. */
export function groupWords(words: Word[], o: { maxWords?: number; maxS?: number; gapS?: number } = {}): Line[] {
  const { maxWords = 5, maxS = 2.5, gapS = 0.7 } = o;
  const out: Line[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((x) => x.text).join(' '), start: cur[0].startS, end: cur[cur.length - 1].endS });
    cur = [];
  };
  for (const raw of words) {
    const text = raw.text.trim();
    if (!text) continue;
    const word = { ...raw, text };
    const last = cur[cur.length - 1];
    if (last && (cur.length >= maxWords || word.endS - cur[0].startS > maxS || word.startS - last.endS > gapS)) flush();
    cur.push(word);
  }
  flush();
  return out;
}
