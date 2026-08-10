import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'lib/universe/companies.ts',
        'lib/ingestion/scoring.ts',
        'lib/ingestion/parsers/**/*.ts',
        'lib/api/adminAuth.ts',
      ],
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
