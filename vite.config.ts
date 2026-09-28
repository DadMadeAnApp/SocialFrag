/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** .ts tests that render hooks or use document/localStorage; every other .ts test runs without a DOM. */
const DOM_TS_TESTS = [
  'src/backend/fake.test.ts',
  'src/components/useEditorKeys.test.ts',
  'src/state/useMedia.test.ts',
  'src/state/useThumbnails.test.ts',
  'src/timeline/history.test.ts',
];

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    // jsdom costs ~1.5 s per test file and was 70% of suite time; under full-suite load that CPU
    // contention slowed App/ExportPanel tests toward their timeouts. Only files that touch the DOM get it.
    projects: [
      {
        extends: true,
        test: { name: 'dom', environment: 'jsdom', setupFiles: ['src/test/setup.ts'], include: ['src/**/*.test.tsx', ...DOM_TS_TESTS] },
      },
      { extends: true, test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts'], exclude: DOM_TS_TESTS } },
    ],
  },
});
