import { test, expect, type BrowserContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { NodeView } from '@traffic/contracts';
import { bytes } from '../../apps/web/src/format.js';

let sessionCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test.beforeEach(async ({ page, context }, testInfo) => {
  page.on('pageerror', error => { throw error; });
  const separateLogin = testInfo.title.startsWith('logout');
  const reuseSession = sessionCookies.length > 0 && !separateLogin;
  if (reuseSession) await context.addCookies(sessionCookies);
  await page.goto('/');
  if (!reuseSession) {
    await page.getByLabel('管理员账号').fill('qa-admin');
    await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password');
    await page.getByRole('button', { name: '登录后台' }).click();
  }
  await expect(page.getByRole('heading', { name: '全局概览' })).toBeVisible();
  if (!separateLogin) sessionCookies = await context.cookies();
});

test('desktop overview renders real API data and two independent Go Agents', async ({ page }) => {
  await expect(page.getByText('实时数据已连接')).toBeVisible();
  await expect(page.getByRole('link', { name: /本机采集 · A/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /本机采集 · B/ }).first()).toBeVisible();
  const response = await page.request.get('/api/v1/nodes');
  const nodes = (await response.json()).nodes;
  const live = nodes.filter((n: { name: string }) => n.name.startsWith('本机采集'));
  expect(live).toHaveLength(2);
  for (const node of live) { expect(node.status).toBe('online'); expect(node.snapshot.agent_version).toBe('1.3.0'); expect(node.snapshot.cpu_cores).toBeGreaterThan(0); }
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop-overview.png', fullPage: true });
});

test('node list supports search and group filtering', async ({ page }) => {
  await page.goto('/nodes');
  await page.getByLabel('搜索服务器').fill('东京');
  await expect(page.getByRole('link', { name: /东京 · 核心节点/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /法兰克福 · 网关/ })).toHaveCount(0);
  await page.getByLabel('搜索服务器').fill('');
  await page.getByLabel('分组筛选').click();
  await page.getByText('欧洲', { exact: true }).last().click();
  await expect(page.getByRole('link', { name: /法兰克福 · 网关/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /东京 · 核心节点/ })).toHaveCount(0);
});

test('detail direct links, range changes and refresh preserve the node', async ({ page }) => {
  const nodes = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const node = nodes.find((n: { name: string }) => n.name === '东京 · 核心节点');
  await page.goto(`/nodes/${node.id}`);
  await expect(page.getByRole('heading', { name: node.name })).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.getByText('7 天', { exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: node.name })).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/desktop-detail.png', fullPage: true });
});

test('a real Go Agent acknowledges a new monitoring configuration', async ({ page }) => {
  const nodes = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const node = nodes.find((n: { name: string }) => n.name === '本机采集 · A');
  await page.goto(`/nodes/${node.id}`);
  await page.getByRole('tab', { name: '节点设置' }).click();
  await page.getByLabel('每月起始日').fill('15');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText(/已应用 · v2/)).toBeVisible({ timeout: 20000 });
});

test('create node flow navigates to an empty but valid detail page', async ({ page }) => {
  await page.goto('/connect');
  await page.getByLabel('节点名称').fill('浏览器新建节点');
  await page.getByRole('button', { name: '创建节点并生成配置' }).click();
  await expect(page.getByRole('heading', { name: '浏览器新建节点 已创建' })).toBeVisible();
  await page.getByRole('button', { name: '查看节点与连接状态' }).click();
  await expect(page.getByRole('heading', { name: '浏览器新建节点' })).toBeVisible();
  await expect(page.getByText('等待 Agent 首次上报')).toBeVisible();
});

test('SSE reconnect restores live updates while HTTP snapshot data remains visible', async ({ page, context }) => {
  await context.route('**/api/v1/events', route => route.abort());
  await page.reload();
  await expect(page.getByText('正在重连')).toBeVisible();
  await expect(page.getByRole('heading', { name: '全局概览' })).toBeVisible();
  await expect(page.getByText('东京 · 核心节点', { exact: true }).first()).toBeVisible();
  await context.unroute('**/api/v1/events');
  await expect(page.getByText('实时数据已连接')).toBeVisible({ timeout: 15000 });
});

test('mobile and tablet layouts fit and navigation and themes work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/mobile-overview.png', fullPage: true });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('menuitem', { name: 'VPS 管理' }).click();
  await expect(page.getByRole('heading', { name: 'VPS 管理' })).toBeVisible();
  await expect(page.locator('.mobile-node-cards')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/mobile-nodes.png', fullPage: true });
  const nodes = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const detail = nodes.find((n: { name: string }) => n.name === '东京 · 核心节点');
  await page.goto(`/nodes/${detail.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/mobile-detail.png', fullPage: true });
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/overview');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/tablet-overview.png', fullPage: true });
});

test('logout clears access and returns to login', async ({ page }) => {
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录后台' })).toBeVisible();
  expect((await page.request.get('/api/v1/nodes')).status()).toBe(401);
});

test('compact node table expands by keyboard and keeps its state during refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/nodes');
  const toggle = page.getByRole('button', { name: '展开 东京 · 核心节点 运行详情' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  const preview = page.locator('.desktop-node-table .node-preview').filter({ hasText: 'tokyo-core-01' });
  await expect(preview).toBeVisible();
  await expect(preview.getByText('内存 已用 / 总量')).toBeVisible();
  await expect(preview.getByText('Swap 使用率 / 总量')).toBeVisible();
  await expect(preview.getByText('流量统计周期')).toBeVisible();
  await page.getByLabel('搜索服务器').fill('东京');
  await page.getByRole('button', { name: '刷新数据' }).click();
  await expect(page.getByLabel('搜索服务器')).toHaveValue('东京');
  await expect(preview).toBeVisible();
  const collapse = page.getByRole('button', { name: '收起 东京 · 核心节点 运行详情' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.focus();
  await page.keyboard.press('Space');
  await expect(preview).toBeHidden();
  await expect(page.getByRole('button', { name: '展开 东京 · 核心节点 运行详情' })).toHaveAttribute('aria-expanded', 'false');
});

test('month traffic sorts by bytes and offline resources are clearly unavailable', async ({ page }) => {
  const nodes: NodeView[] = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  await page.goto('/nodes');
  const month = page.getByRole('columnheader', { name: /月流量/ });
  await month.click();
  await expect(month).toHaveAttribute('aria-sort', 'ascending');
  const orderedNames = await page.locator('.desktop-node-table .node-table-name strong').allTextContents();
  const orderedValues = orderedNames.map(name => BigInt(nodes.find(node => node.name === name)!.traffic.month.total_bytes));
  expect(orderedValues.every((value, index) => !index || value >= orderedValues[index - 1])).toBe(true);
  await month.click();
  await expect(month).toHaveAttribute('aria-sort', 'descending');
  const descendingNames = await page.locator('.desktop-node-table .node-table-name strong').allTextContents();
  const descendingValues = descendingNames.map(name => BigInt(nodes.find(node => node.name === name)!.traffic.month.total_bytes));
  expect(descendingValues.every((value, index) => !index || value <= descendingValues[index - 1])).toBe(true);
  await page.getByLabel('搜索服务器').fill('洛杉矶');
  const row = page.locator('.desktop-node-table tr').filter({ has: page.getByRole('link', { name: /洛杉矶 · 备用/ }) });
  await expect(row.locator('.resource-offline')).toHaveCount(3);
  await expect(row.locator('[role="meter"]')).toHaveCount(0);
  await expect(row.locator('.traffic-speed')).toHaveText('—/—');
  const offline = nodes.find(node => node.name === '洛杉矶 · 备用')!;
  await expect(row.locator('.monthly-traffic')).toContainText(bytes(offline.traffic.month.rx_bytes));
  await page.getByRole('button', { name: '展开 洛杉矶 · 备用 运行详情' }).click();
  await expect(page.getByText('当前离线，以下为最后同步的记录。').first()).toBeVisible();
});

test('node preview handles missing metrics and refresh failures without discarding data', async ({ page, context }) => {
  await context.route('**/api/v1/events', route => route.abort());
  const nodes: NodeView[] = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const online = structuredClone(nodes.find(node => node.name === '本机采集 · A')!);
  online.snapshot!.cpu_percent = null;
  online.snapshot!.memory_percent = 94;
  online.snapshot!.disks.find(disk => disk.mount === '/')!.used_percent = 78;
  await page.route('**/api/v1/nodes', route => route.fulfill({ json: { nodes: [online] } }));
  await page.goto('/nodes');
  await page.reload();
  const table = page.locator('.desktop-node-table');
  await expect(table.locator('.resource-unavailable')).toHaveText('—');
  await expect(table.getByRole('meter', { name: '内存', exact: true })).toHaveAttribute('aria-valuenow', '94');
  await expect(table.locator('.resource-danger')).toBeVisible();
  await expect(table.locator('.resource-warning')).toBeVisible();
  await page.unroute('**/api/v1/nodes');
  await page.route('**/api/v1/nodes', route => route.fulfill({ status: 503, json: { error: '测试服务暂时不可用' } }));
  await page.getByRole('button', { name: '刷新数据' }).click();
  await expect(page.getByRole('alert')).toContainText('刷新失败，显示上次同步数据');
  await expect(table.getByRole('link', { name: /本机采集 · A/ })).toBeVisible();
});

test('node monitor fits desktop tablet and narrow phones in both themes', async ({ page }) => {
  await page.goto('/nodes');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole('button', { name: '展开 东京 · 核心节点 运行详情' }).click();
  await page.screenshot({ path: 'artifacts/vps-nodes-desktop-dark.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'artifacts/vps-nodes-desktop-light.png', fullPage: true, animations: 'disabled' });
  for (const width of [1440, 1024, 768, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 768) await page.screenshot({ path: 'artifacts/vps-nodes-tablet.png', fullPage: true, animations: 'disabled' });
    if (width === 390) {
      const card = page.locator('.mobile-node-cards .node-mobile-card').filter({ has: page.getByRole('link', { name: '东京 · 核心节点', exact: true }) });
      await card.locator('summary').click();
      await expect(card.getByText('内存 已用 / 总量')).toBeVisible();
      await expect(card.getByText('月流量', { exact: true })).toBeVisible();
      await page.screenshot({ path: 'artifacts/vps-nodes-mobile.png', fullPage: true, animations: 'disabled' });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.mobile-node-cards')).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('heading', { name: 'VPS 管理' })).toBeVisible();
});
