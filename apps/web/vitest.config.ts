import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next.js keeps JSX as-is (tsconfig jsx: preserve); tests compile it with the React runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/**/*.test.ts'],
    // React components are rendered with react-dom/server in tests (no browser DOM needed).
    environment: 'node',
  },
});
