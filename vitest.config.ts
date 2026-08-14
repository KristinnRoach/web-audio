import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node', // ? jsdom ? // Creates an isolated test environment
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.browser.test.ts', 'node_modules/**'],

    coverage: {
      reporter: ['text', 'html'],
    },

    testTimeout: 10000,
    setupFiles: [],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

// ? try the commented out config below
// import { fileURLToPath, URL } from 'node:url';
// import { defineConfig } from 'vitest/config';

// export default defineConfig({
//   test: {
//     browser: {
//       enabled: true,
//       headless: true,
//       name: 'chrome',
//     },
//     // logHeapUsage: true,
//     reporters: 'default',
//     benchmark: {
//       include: ['**/*.bench.{js,ts}'],
//     },
//   },
//   resolve: {
//     alias: {
//       '@': fileURLToPath(new URL('./src', import.meta.url)),
//       '@test': fileURLToPath(new URL('./test', import.meta.url)),
//     },
//   },
// });
