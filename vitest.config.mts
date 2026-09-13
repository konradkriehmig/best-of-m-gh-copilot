import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

// `npm run smoke` emits compiled JS to out/, which would otherwise be collected as a
// duplicate (and unrunnable) copy of every test suite.
export default defineConfig({
  resolve: {
    // `vscode` only exists inside the extension host, so tests get a stub.
    alias: {
      vscode: path.resolve(__dirname, 'src/test/vscodeStub.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'out/**'],
  },
});
