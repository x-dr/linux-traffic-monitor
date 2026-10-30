import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 30000,
  expect: { timeout: 10000 }, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:18766', viewport: { width: 1440, height: 1000 }, launchOptions: { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
  webServer: { command: 'node --import tsx scripts/qa-server.ts', url: 'http://127.0.0.1:18766/health', reuseExistingServer: false, timeout: 30000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
});
