import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The determinism fuzz suite runs tens of thousands of ticks; give it room.
    testTimeout: 60_000,
  },
});
