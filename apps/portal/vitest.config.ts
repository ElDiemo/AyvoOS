import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      // The server-only guard throws outside a React server build; the unit tests are server code.
      'server-only': new URL('./src/lib/server-only.test-stub.ts', import.meta.url).pathname,
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
