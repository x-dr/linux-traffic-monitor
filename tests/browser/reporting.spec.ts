import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await page.getByLabel('管理员账号').fill('qa-admin');
  await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password');
  await page.getByRole('button', { name: '登录后台' }).click();
  await expect(page.getByRole('heading', { name: '全局概览' })).toBeVisible();
});

test('reporting options persist, a real Agent applies them and 15 second reports remain online', async ({ page }) => {
  test.setTimeout(90000);
  const nodes = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const node = nodes.find((n: { name: string }) => n.name === '本机采集 · A');
  await page.goto(`/nodes/${node.id}?tab=settings`);
  const panel = page.getByRole('region', { name: 'Agent 上报设置' });
  await expect(panel.getByText('已应用', { exact: true })).toBeVisible({ timeout: 20000 });
  await panel.getByLabel('上报间隔', { exact: true }).click();
  for (const interval of [1, 3, 5, 10, 15]) await expect(page.getByRole('option', { name: `${interval} 秒`, exact: true })).toBeAttached();
  await page.getByText('1 秒', { exact: true }).last().click();
  await panel.getByRole('button', { name: '保存上报间隔' }).click();
  await expect(panel.getByText('已应用', { exact: true })).toBeVisible({ timeout: 20000 });
  await panel.getByLabel('上报间隔', { exact: true }).click();
  await page.getByText('15 秒', { exact: true }).last().click();
  await panel.getByRole('button', { name: '保存上报间隔' }).click();
  const reporting = () => page.request.get(`/api/v1/nodes/${node.id}/reporting`).then(r => r.json());
  await expect.poll(async () => { const view = await reporting(); return view.interval_seconds === 15 && view.config_version === view.applied_version; }, { timeout: 25000 }).toBe(true);
  const appliedAt = (await (await page.request.get(`/api/v1/nodes/${node.id}`)).json()).last_received_at;
  await expect.poll(async () => (await (await page.request.get(`/api/v1/nodes/${node.id}`)).json()).last_received_at, { timeout: 22000, intervals: [1000] }).toBeGreaterThan(appliedAt + 12);
  expect((await (await page.request.get(`/api/v1/nodes/${node.id}`)).json()).status).toBe('online');
  await page.reload();
  await expect(panel.getByText('15 秒', { exact: true })).toBeVisible();
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/reporting-desktop.png', fullPage: true });
  await panel.getByLabel('上报间隔', { exact: true }).click();
  await page.getByText('5 秒', { exact: true }).last().click();
  await panel.getByRole('button', { name: '保存上报间隔' }).click();
  await expect.poll(async () => (await reporting()).interval_seconds).toBe(5);
});

test('old Agents show upgrade status and mobile refresh keeps an unsaved interval', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const nodes = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const node = nodes.find((n: { name: string }) => n.name === '东京 · 核心节点');
  await page.goto(`/nodes/${node.id}?tab=settings`);
  const panel = page.getByRole('region', { name: 'Agent 上报设置' });
  await expect(panel.getByText('需升级 Agent', { exact: true })).toBeVisible();
  await panel.getByLabel('上报间隔', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(panel.getByText('3 秒', { exact: true }).last()).toBeVisible();
  await page.waitForResponse(response => response.url().endsWith(`/nodes/${node.id}/reporting`) && response.request().method() === 'GET');
  await expect(panel.getByText('3 秒', { exact: true }).last()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/reporting-mobile.png', fullPage: true });
  await panel.getByRole('button', { name: '保存上报间隔' }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/nodes/${node.id}/reporting`)).json()).interval_seconds).toBe(3);
  await expect(panel.getByText('需升级 Agent', { exact: true })).toBeVisible();
});
