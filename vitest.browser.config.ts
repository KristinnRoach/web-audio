import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['**/*.browser.test.ts'],
    browser: {
      enabled: true,
      instances: [{ browser: 'chromium' }], // or 'firefox', 'webkit'
      provider: 'playwright',
      headless: true, // Set to false to see the browser
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
