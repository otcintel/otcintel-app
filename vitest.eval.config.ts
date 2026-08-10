import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest configuration for golden evaluation runs.
 *
 * Usage:
 *   npm run eval             — concise output
 *   npm run eval:verbose     — field-level detail on every case
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['evals/**/*.eval.ts'],
    reporters: [process.env.EVAL_VERBOSE === '1' ? 'verbose' : 'default'],
    // Evals are not coverage targets — they test the framework, not individual functions
    coverage: { enabled: false },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
