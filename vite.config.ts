import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';

export default defineConfig({
  base: './',
  plugins: [
    dts({
      include: ['src'],
      exclude: ['**/*.test.ts', '**/__tests__/**'],
      outDir: 'dist',
      rollupTypes: true,
    }),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: false, // necessary to prevent worklets being erased (when using build-processors.js)
    // assetsInlineLimit: 0, // Prevent inlining (not needed when using build-processors.js)

    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        io: resolve(__dirname, 'src/io/index.ts'),
        components: resolve(__dirname, 'src/components/index.ts'),
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
