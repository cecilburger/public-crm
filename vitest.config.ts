import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@kirana/core': r('./packages/core/src/index.ts'),
      '@kirana/db': r('./packages/db/src/index.ts'),
    },
  },
});
