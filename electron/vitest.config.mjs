import { defineConfig } from 'vitest/config';

// Tests for the Electron desktop shell (components installer, etc.).
// Kept separate from the root config, which only scans src/ and extensions/.
export default defineConfig({
  test: {
    include: ['**/*.test.js'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
