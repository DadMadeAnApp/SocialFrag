const FACES = ['600 80px Inter', '800 80px Inter', '80px Anton', '80px "Bebas Neue"'];

/** Canvas text uses fallback fonts until the webfont is loaded; call before drawing captions for export. */
export async function ensureFonts(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  await Promise.all(FACES.map((f) => document.fonts.load(f)));
}
