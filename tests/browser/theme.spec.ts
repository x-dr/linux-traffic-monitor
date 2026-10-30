import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test.beforeEach(({ page }) => {
  page.on('pageerror', error => { throw error; });
});

for (const scenario of [
  { name: 'desktop-light', stored: 'light', expected: 'light', width: 1440, blockedStorage: false },
  { name: 'mobile-light', stored: 'light', expected: 'light', width: 390, blockedStorage: false },
  { name: 'desktop-dark', stored: 'dark', expected: 'dark', width: 1440, blockedStorage: false },
  { name: 'default-dark', stored: null, expected: 'dark', width: 1440, blockedStorage: false },
  { name: 'storage-unavailable', stored: 'light', expected: 'dark', width: 1440, blockedStorage: true },
]) {
  test(`theme is correct before styles and React load on refresh: ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: '登录后台' })).toBeVisible();
    await page.evaluate(stored => {
      if (stored) localStorage.setItem('observatory-theme', stored);
      else localStorage.removeItem('observatory-theme');
    }, scenario.stored);
    if (scenario.blockedStorage) await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Storage is unavailable', 'SecurityError'); },
      });
    });

    const scripts = deferred(), styles = deferred();
    await page.route('**/assets/**', async route => {
      if (route.request().resourceType() === 'script') await scripts.promise;
      if (route.request().resourceType() === 'stylesheet') await styles.promise;
      await route.continue();
    });
    const background = scenario.expected === 'light' ? 'rgb(243, 246, 250)' : 'rgb(12, 18, 32)';
    const themeColor = scenario.expected === 'light' ? '#f3f6fa' : '#0c1220';
    try {
      await page.reload({ waitUntil: 'commit' });
      await expect(page.locator('#root')).toBeAttached();
      await expect(page.locator('#root')).toBeEmpty();
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.expected);
      await expect(page.locator('html')).toHaveCSS('background-color', background);
      await expect(page.locator('html')).toHaveCSS('color-scheme', scenario.expected);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', themeColor);

      styles.release();
      await expect(page.locator('body')).toHaveCSS('background-color', background);
      await expect(page.locator('#root')).toBeEmpty();
      mkdirSync('artifacts', { recursive: true });
      await page.screenshot({ path: `artifacts/theme-${scenario.name}-before-react.png`, animations: 'disabled' });

      scripts.release();
      await expect(page.getByRole('button', { name: '登录后台' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.expected);
      await expect(page.locator('body')).toHaveCSS('background-color', background);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', themeColor);
    } finally {
      styles.release();
      scripts.release();
    }
  });
}

test('theme switches update browser colors and survive refresh', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('管理员账号').fill('qa-admin');
  await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password');
  await page.getByRole('button', { name: '登录后台' }).click();
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: '切换主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', theme === 'light' ? '#f3f6fa' : '#0c1220');
    expect(await page.evaluate(() => localStorage.getItem('observatory-theme'))).toBe(theme);
    await page.reload();
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  }
});
