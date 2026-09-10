import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * `JWT_SECRET` is set here because `config/env.ts` refuses to load without one,
 * and every module that touches constants pulls it in transitively. A test
 * secret is fine: nothing in the suite verifies a token minted elsewhere.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-that-is-only-used-by-the-suite',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/scribbleAndGuess_test',
      LOG_LEVEL: 'error',
    },
  },
});
