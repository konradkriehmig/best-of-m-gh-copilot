import { defineConfig } from 'vitest/config';

// `npm run smoke` emits compiled JS to out/, which would otherwise be collected as a
// duplicate (and unrunnable) copy of every test suite.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'out/**'],
  },
});
