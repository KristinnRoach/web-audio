#!/usr/bin/env node
import { build } from "vite";
import { resolve } from "path";
import { pathToFileURL } from "url";
import fs from "fs";

export async function buildProcessors() {
  console.log("Building AudioWorklet processors...");

  const outDir = "dist/processors";
  const outputDir = resolve(outDir);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await build({
    configFile: false,
    build: {
      lib: {
        entry: resolve("./src/worklets/processors/index.ts"),
        formats: ["es"],
        fileName: "processors",
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
  console.log("AudioWorklet processors built successfully");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await buildProcessors();
  } catch (error) {
    console.error("Error building AudioWorklet processors:", error);
    process.exitCode = 1;
  }
}
