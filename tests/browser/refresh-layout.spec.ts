import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';

let sessionCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function shellBounds(page: Page) {
  return page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width };
    };
    return {
      content: bounds('.main-content'),
      header: bounds('.topbar'),
      sidebar: bounds('.desktop-sidebar'),
      documentWidth: document.documentElement.clientWidth,
      fits: document.documentElement.scrollWidth <= innerWidth,
    };
  });
}

test.beforeEach(({ page }) => {
  page.on('pageerror', error => { throw error; });
});

for (const scenario of [
  { name: 'desktop-light', width: 1440, light: true, collapsed: false },
  { name: 'desktop-collapsed', width: 1440, light: false, collapsed: true },
  { name: 'mobile-dark', width: 390, light: false, collapsed: false },
]) {
  test(`refresh keeps workspace dimensions during slow session and data responses: ${scenario.name}`, async ({ page, context }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    if (sessionCookies.length) await context.addCookies(sessionCookies);
    await page.goto('/nodes');
    if (!sessionCookies.length) {
      await page.getByLabel('管理员账号').fill('qa-admin');
      await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password');
      await page.getByRole('button', { name: '登录后台' }).click();
    }
    await expect(page.getByRole('heading', { name: 'VPS 管理' })).toBeVisible();
    sessionCookies = await context.cookies();
    if (scenario.light) await page.getByRole('button', { name: '切换主题' }).click();
    if (scenario.collapsed) {
      await page.getByRole('button', { name: '折叠导航' }).click();
      await expect(page.locator('.desktop-sidebar')).toHaveCSS('width', '80px');
    }
    const before = await shellBounds(page);
    expect(before.fits).toBe(true);

    const session = deferred(), data = deferred();
    const protectedRequests: string[] = [];
    page.on('request', request => {
      if (/\/api\/v1\/(nodes|overview|events)(\/|\?|$)/.test(request.url())) protectedRequests.push(request.url());
    });
    await context.route('**/api/v1/events', route => route.abort());
    await page.route('**/api/v1/auth/session', async route => {
      await session.promise;
      await route.continue();
    });
    await page.route('**/api/v1/nodes', async route => {
      await data.promise;
      await route.continue();
    });

    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.app-layout')).toBeVisible();
      await expect(page.getByRole('status', { name: '正在加载页面' })).toBeVisible();
      await expect(page.getByRole('button', { name: '退出登录' })).toBeDisabled();
      expect(await shellBounds(page)).toEqual(before);
      expect(protectedRequests).toEqual([]);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.light ? 'light' : 'dark');
      mkdirSync('artifacts', { recursive: true });
      await page.screenshot({ path: `artifacts/refresh-${scenario.name}-loading.png`, fullPage: true, animations: 'disabled' });

      session.release();
      await expect(page.getByRole('button', { name: '退出登录' })).toBeEnabled();
      await expect(page.getByRole('status', { name: '正在加载页面' })).toBeVisible();
      expect(await shellBounds(page)).toEqual(before);
      const loadingPanel = await page.locator('.loading-panel').boundingBox();

      data.release();
      await expect(page.getByRole('heading', { name: 'VPS 管理' })).toBeVisible();
      expect(await shellBounds(page)).toEqual(before);
      const panel = await page.getByRole('region', { name: 'VPS 监控' }).boundingBox();
      expect(panel!.x).toBe(loadingPanel!.x);
      expect(panel!.width).toBe(loadingPanel!.width);
      if (scenario.collapsed) await expect(page.getByRole('button', { name: '展开导航' })).toHaveAttribute('aria-expanded', 'false');
      await page.screenshot({ path: `artifacts/refresh-${scenario.name}-ready.png`, fullPage: true, animations: 'disabled' });
    } finally {
      session.release();
      data.release();
    }
  });
}

test('refresh of an expired detail session waits for authentication before requesting protected data', async ({ page, context }) => {
  await context.clearCookies();
  const session = deferred();
  const protectedRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/v1\/(nodes|overview|events)(\/|\?|$)/.test(request.url())) protectedRequests.push(request.url());
  });
  await page.route('**/api/v1/auth/session', async route => {
    await session.promise;
    await route.fulfill({ status: 401, json: { error: '会话已过期' } });
  });
  try {
    await page.goto('/nodes/expired-session');
    await expect(page.getByRole('status', { name: '正在加载页面' })).toBeVisible();
    expect(protectedRequests).toEqual([]);
    session.release();
    await expect(page.getByRole('button', { name: '登录后台' })).toBeVisible();
    await expect(page.locator('.app-layout')).toHaveCount(0);
    expect(protectedRequests).toEqual([]);
  } finally {
    session.release();
  }
});
