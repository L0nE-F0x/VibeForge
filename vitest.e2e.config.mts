import { defineConfig } from 'vitest/config';

// `npm run e2e`: the built app, started and driven over DevTools for each scenario in e2e/
// (see e2e/driver/app.ts and CONTRIBUTING.md). Each file starts its own app on its own scratch
// folders, so files run side by side; two at a time keeps a 2-core CI runner from starving them.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 2,
  },
});
