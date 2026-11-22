/// <reference types="node" />

import { defineConfig } from 'vite-plus';
import { playwright } from 'vite-plus/test/browser-playwright';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    // Only for code that needs a real AudioContext or AudioParam. A scheduling test that
    // mocks both belongs in the node suite, where it runs without booting Chrome and is
    // covered by `vp check` — see Envelope.loop.test.ts and fakeParam.ts.
    include: ['**/*.browser.test.ts'],
    browser: {
      locators: {
        // Vitest v4 compatibility: keep partial, case-insensitive locator matching.
        // Remove after updating locators for full, case-sensitive matches.
        // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
        // https://vitest.dev/guide/migration/#locators-are-strict-by-default
        exact: false,
      },
      enabled: true,
      instances: [{ browser: 'chromium' }], // or 'firefox', 'webkit'
      provider: playwright({
        launchOptions: {
          channel: 'chrome',
          // A new AudioContext otherwise stays suspended and resume() never settles.
          args: ['--autoplay-policy=no-user-gesture-required'],
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
