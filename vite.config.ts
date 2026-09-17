/// <reference types="node" />

import { defineConfig, lazyPlugins } from 'vite-plus';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';
import { buildProcessors } from './build-processors.js';

function audioWorkletPlugin() {
  let built = false;

  return {
    name: 'build-audio-worklets',
    async buildStart() {
      if (built) return;
      built = true;
      await buildProcessors();
    },
  };
}

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  fmt: {
    singleQuote: true,
  },
  lint: {
    ignorePatterns: ['**/*.browser.test.ts'],
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      // fakeParam imports `vite-plus/test`, so it must never be reachable from the
      // bundle. Its own folder reaches it as './fakeParam'; anywhere else has to spell
      // a `test/` segment, which is what this catches.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/test/fakeParam', '**/test/fakeParam.ts'],
              message:
                'createFakeParam is a test double and stays in envelopes/test/. Importing it elsewhere pulls vite-plus/test towards the bundle.',
            },
          ],
        },
      ],
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.browser.test.ts', 'node_modules/**'],
    coverage: {
      reporter: ['text', 'html'],
    },
    testTimeout: 10000,
  },
  base: './',
  plugins: lazyPlugins(() => [
    audioWorkletPlugin(),
    dts({
      include: ['src'],
      // `**/test/**` keeps helpers that are not themselves *.test.ts out of the types,
      // fakeParam.ts being the one that would otherwise slip through.
      exclude: ['**/*.test.ts', '**/__tests__/**', '**/test/**'],
      outDir: 'dist',
      rollupTypes: true,
    }),
  ]),

  build: {
    outDir: 'dist',
    emptyOutDir: false, // necessary to prevent worklets being erased (when using build-processors.js)
    // assetsInlineLimit: 0, // Prevent inlining (not needed when using build-processors.js)

    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        io: resolve(import.meta.dirname, 'src/io/index.ts'),
        components: resolve(import.meta.dirname, 'src/components/index.ts'),
        debug: resolve(import.meta.dirname, 'src/debug/index.ts'),
      },
      name: '@kidlib/web-audio',
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ['webmidi'],
    },
    // output: { globals: {}, }, // skoða
  },
  resolve: {
    // extensions: ['.js', '.ts'], // TOdo: henda
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

// server configuration to serve html test files
// server: {
//   fs: {
//     // Allow serving files from one level up
//     allow: ['..', './dist'],
//   },
// },
// Configured to serve test HTML files
// publicDir: 'public',
