import { defineConfig, devices } from '@playwright/test';
const baseURL = process.env.QQM_E2E_URL || 'http://127.0.0.1:18082';
export default defineConfig({
  testDir: './e2e', outputDir: process.env.QQM_SOAK_SECONDS ? 'test-results/soak' : 'test-results/acceptance', timeout: 60000, expect: { timeout: 12000 },
  fullyParallel: false, workers: 1, retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: process.env.QQM_SOAK_SECONDS ? 'test-results/soak-results.json' : 'test-results/acceptance-results.json' }]],
  use: { baseURL, trace: process.env.QQM_SOAK_SECONDS ? 'off' : 'retain-on-failure', screenshot: 'only-on-failure', video: process.env.QQM_SOAK_SECONDS || process.env.QQM_NO_VIDEO ? 'off' : 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.QQM_BROWSER_CHANNEL || undefined } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
  ],
});
