import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    fileParallelism: false,
    // `npm run coverage`: what the tests reach. The core (storage, scheduler, the service) has a
    // floor; the window and the main process are covered by the smoke test instead.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.{ts,cjs}'],
      exclude: ['src/ui/i18n/*.ts'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: { 'src/core/**': { lines: 85 } },
    },
  },
});
