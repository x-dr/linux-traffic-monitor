import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { History, NodeView } from '@traffic/contracts';
import { bytes } from '../../apps/web/src/format.js';

let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let nodes: NodeView[] = [];

async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByText(value, { exact: true }).last().click();
}
function summary(page: Page, region: string, label: string) {
  return page.getByRole('region', { name: region }).locator('.history-summary-item').filter({ hasText: label }).locator('strong');
}
function nextHistory(page: Page, filters: Record<string, string>) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return /\/nodes\/[^/]+\/history$/.test(url.pathname) && response.request().resourceType() === 'fetch'
      && Object.entries(filters).every(([key, value]) => url.searchParams.get(key) === value);
  }).then(response => response.json() as Promise<History>);
}

test.beforeEach(async ({ page, context }) => {
  page.on('pageerror', error => { throw error; });
  if (cookies.length) await context.addCookies(cookies);
  await page.goto('/');
  if (!cookies.length) {
    await page.getByLabel('管理员账号').fill('qa-admin');
    await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password');
    await page.getByRole('button', { name: '登录后台' }).click();
  }
  await expect(page.getByRole('heading', { name: '全局概览' })).toBeVisible();
  cookies = await context.cookies();
  nodes = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const node = nodes.find(node => node.name === '东京 · 核心节点')!;
  await page.goto(`/nodes/${node.id}`);
  await expect(page.getByRole('img', { name: '硬盘读取和写入速度趋势图' })).toBeVisible();
});

test('network history filters exact totals, switches volume, aggregates by day and survives refresh', async ({ page }) => {
  const changed = nextHistory(page, { interface: 'eth1' });
  await select(page, '历史网卡筛选', 'eth1');
  await expect(page).toHaveURL(/interface=eth1/);
  const expected = await changed;
  await expect(summary(page, '网卡流量历史', '区间下载')).toHaveText(bytes(expected.network.total.rx_bytes));
  await expect(summary(page, '网卡流量历史', '区间上传')).toHaveText(bytes(expected.network.total.tx_bytes));
  await page.getByText('流量', { exact: true }).click();
  await expect(page.getByRole('img', { name: '上下行网络流量趋势图' })).toBeVisible();
  const daily = nextHistory(page, { interface: 'eth1', granularity: 'day' });
  await select(page, '历史聚合粒度', '按天（UTC）');
  await expect(page).toHaveURL(/granularity=day/);
  await expect(page.getByText(/按天（UTC）聚合/)).toBeVisible();
  const dailyHistory = await daily;
  expect(dailyHistory.minutes).toBe(60);
  await expect(summary(page, '网卡流量历史', '区间下载')).toHaveText(bytes(dailyHistory.network.total.rx_bytes));
  await page.getByText('7 天', { exact: true }).click();
  await expect(page).toHaveURL(/minutes=10080/);
  await page.reload();
  await expect(page.getByRole('img', { name: '上下行网络流量趋势图' })).toBeVisible();
  await expect(page.locator('.history-device-select').filter({ has: page.getByRole('combobox', { name: '历史网卡筛选' }) })).toContainText('eth1');
  await expect(page.getByText(/按天（UTC）聚合/)).toBeVisible();
});

test('disk selection changes byte totals independently of network selection and refresh retains it', async ({ page }) => {
  // Compare with the exact response used by the UI: a separate API request can cross a minute boundary.
  const changed = nextHistory(page, { device: 'vdb' });
  await select(page, '历史磁盘筛选', 'vdb');
  const expected = await changed;
  await expect(summary(page, '硬盘读写历史', '区间读取')).toHaveText(bytes(expected.disk_io.total.read_bytes));
  await expect(summary(page, '硬盘读写历史', '区间写入')).toHaveText(bytes(expected.disk_io.total.write_bytes));
  const networkChanged = nextHistory(page, { device: 'vdb', interface: 'eth1' });
  await select(page, '历史网卡筛选', 'eth1');
  const combined = await networkChanged;
  expect(combined.disk_io.device).toBe('vdb');
  await expect(summary(page, '硬盘读写历史', '区间读取')).toHaveText(bytes(combined.disk_io.total.read_bytes));
  const refreshed = nextHistory(page, { device: 'vdb', interface: 'eth1' });
  await page.reload();
  await expect(page).toHaveURL(/device=vdb/);
  await expect(summary(page, '硬盘读写历史', '区间读取')).toHaveText(bytes((await refreshed).disk_io.total.read_bytes));
});

test('legacy and unavailable devices have empty states instead of zero or fabricated history', async ({ page }) => {
  const old = nodes.find(node => node.name === '洛杉矶 · 备用')!;
  await page.goto(`/nodes/${old.id}`);
  await expect(page.getByText('暂无硬盘读写历史，请升级 Agent 后等待采样。')).toBeVisible();
  await expect(summary(page, '硬盘读写历史', '区间读取')).toHaveText('—');
  const node = nodes.find(node => node.name === '东京 · 核心节点')!;
  await page.goto(`/nodes/${node.id}?device=removed-disk`);
  await expect(page.getByText('所选区间暂无这块磁盘的读写记录。')).toBeVisible();
  await expect(summary(page, '硬盘读写历史', '区间写入')).toHaveText('—');
});

test('history errors offer retry and recovery renders both charts', async ({ page }) => {
  // Isolate manual recovery from the SSE-driven background invalidations.
  await page.route('**/api/v1/events', route => route.abort());
  await page.reload();
  await expect(page.getByRole('img', { name: '硬盘读取和写入速度趋势图' })).toBeVisible();
  await page.route('**/api/v1/nodes/*/history?**', route => route.fulfill({ status: 503, json: { error: '测试历史暂不可用' } }));
  await page.getByText('6 小时', { exact: true }).click();
  await expect(page.getByText('测试历史暂不可用').first()).toBeVisible();
  const retry = page.getByRole('button', { name: '重试历史数据' });
  await expect(retry).toBeVisible();
  await page.unroute('**/api/v1/nodes/*/history?**');
  await retry.click();
  await expect(page.getByRole('img', { name: '硬盘读取和写入速度趋势图' })).toBeVisible();
});

test('history controls and charts fit desktop tablet and narrow phones in both themes', async ({ page }) => {
  mkdirSync('artifacts', { recursive: true });
  for (const light of [false, true]) {
    if (light) await page.getByRole('button', { name: '切换主题' }).click();
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('combobox', { name: '历史网卡筛选' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: '历史磁盘筛选' })).toBeVisible();
      if (width === 1440 || width === 390) await page.screenshot({ path: `artifacts/history-${width}-${light ? 'light' : 'dark'}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('combobox', { name: '历史磁盘筛选' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/device=vda/);
});

test('two actual local Go Agents report readable disk speed and minute history to the center', async ({ page }) => {
  const live = nodes.filter(node => node.name.startsWith('本机采集'));
  expect(live).toHaveLength(2);
  for (const node of live) {
    await expect.poll(async () => {
      const latest: NodeView = await (await page.request.get(`/api/v1/nodes/${node.id}`)).json();
      return latest.snapshot?.disk_io?.some(disk => disk.read_bps !== null && disk.write_bps !== null);
    }, { timeout: 20000 }).toBe(true);
    const history: History = await (await page.request.get(`/api/v1/nodes/${node.id}/history?minutes=60`)).json();
    expect(history.disk_io.devices.length).toBeGreaterThan(0);
    expect(history.disk_io.total.read_bytes).not.toBeNull();
    expect(history.points.some(point => point.disk_io !== null)).toBe(true);
  }
});
