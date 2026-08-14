#!/usr/bin/env node
import { build } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

console.log('Building AudioWorklet processors manually...');

// Ensure the directory exists
const outDir = 'dist/processors';
const outputDir = resolve('./dist/processors');

if (!fs.existsSync(outputDir)) {
  console.log(`Creating directory: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
}

// Build the processors
try {
  await build({
    configFile: false,
    build: {
      lib: {
        entry: resolve('./src/worklets/processors/index.ts'),
        formats: ['es'],
        fileName: 'processors',
      },
      outDir,
      emptyOutDir: true,
      minify: false,
    },

    esbuild: {
      minifyIdentifiers: false,
      minifySyntax: false,
      minifyWhitespace: false,
    },
  });
  console.log('AudioWorklet processors built successfully');
} catch (error) {
  console.error('Error building AudioWorklet processors:', error);
  process.exit(1);
}
