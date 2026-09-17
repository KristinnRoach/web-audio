/// <reference types="node" />

import { defineConfig } from 'vite-plus';
import { playwright } from 'vite-plus/test/browser-playwright';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Only for code that needs a real AudioContext or AudioParam. A scheduling test that
    // mocks both belongs in the node suite, where it runs without booting Chrome and is
    // covered by `vp check` — see Envelope.loop.test.ts and fakeParam.ts.
    include: ['**/*.browser.test.ts'],
    browser: {
      enabled: true,
      instances: [{ browser: 'chromium' }], // or 'firefox', 'webkit'
      provider: playwright({
        launchOptions: {
          channel: 'chrome',
        },
      }),
      headless: true, // Set to false to see the browser
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
