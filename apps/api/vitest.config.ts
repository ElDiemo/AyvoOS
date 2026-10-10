import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so NestJS decorator metadata (DI) is emitted in tests.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
