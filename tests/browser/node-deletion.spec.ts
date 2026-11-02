import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.goto('/');
  await page.getByLabel('管理员账号').fill('qa-admin');
  await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password');
  await page.getByRole('button', { name: '登录后台' }).click();
  await expect(page.getByRole('heading', { name: '全局概览' })).toBeVisible();
});

async function create(page: Page, name: string) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/nodes', {
    headers: { 'X-CSRF-Token': session.csrf, origin: 'http://127.0.0.1:18766' }, data: { name },
  });
  expect(response.status()).toBe(201);
  const { node } = await response.json();
  await page.goto(`/nodes/${node.id}?tab=settings`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return node as { id: string };
}

test('delete confirmation supports keyboard cancellation and leaves the node intact', async ({ page }) => {
  const node = await create(page, '取消删除验收');
  let requests = 0;
  page.on('request', request => { if (request.method() === 'DELETE') requests++; });
  const trigger = page.getByRole('button', { name: '删除节点', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '永久删除节点？' });
  await expect(dialog).toContainText('无法恢复');
  await expect(dialog).toContainText('原 Agent 令牌立即失效');
  mkdirSync('artifacts', { recursive: true });
  await dialog.screenshot({ path: 'artifacts/node-deletion-desktop.png' });
  await dialog.getByRole('button', { name: /取\s*消/ }).focus(); await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click(); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden(); expect(requests).toBe(0);
  expect((await page.request.get(`/api/v1/nodes/${node.id}`)).status()).toBe(200);
});

test('deletion failure stays reviewable and retry submits once then clears list and overview', async ({ page }) => {
  const node = await create(page, '删除重试验收');
  const before = await (await page.request.get('/api/v1/overview')).json();
  let attempts = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/nodes/${node.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: '测试：暂时无法删除' } });
    await gate; await route.continue();
  });
  await page.getByRole('button', { name: '删除节点', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '永久删除节点？' });
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(dialog.getByRole('alert')).toContainText('删除失败：测试：暂时无法删除');
  expect((await page.request.get(`/api/v1/nodes/${node.id}`)).status()).toBe(200);
  await dialog.getByRole('button', { name: '确认删除' }).click();
  try {
    await expect(dialog.getByRole('button', { name: /取\s*消/ })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    expect(attempts).toBe(2);
  } finally { release(); }
  await expect(page).toHaveURL(/\/nodes$/);
  await expect(page.getByRole('heading', { name: 'VPS 管理' })).toBeVisible();
  await expect(page.getByRole('link', { name: '删除重试验收', exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/nodes/${node.id}`)).status()).toBe(404);
  const after = await (await page.request.get('/api/v1/overview')).json();
  expect(after.nodes).toBe(before.nodes - 1);
  await page.reload(); await expect(page.getByRole('link', { name: '删除重试验收', exact: true })).toHaveCount(0);
});

test('mobile confirmation fits both themes and deletes an archived node', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const node = await create(page, '手机归档删除验收');
  await page.getByRole('button', { name: '归档节点', exact: true }).click();
  await page.getByRole('button', { name: /确\s*定/ }).click();
  await expect(page.getByRole('button', { name: '恢复节点', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除节点', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '永久删除节点？' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.screenshot({ path: 'artifacts/node-deletion-mobile-dark.png' });
  await dialog.getByRole('button', { name: /取\s*消/ }).click();
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('button', { name: '删除节点', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => dialog.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; })).toBe(true);
  await dialog.screenshot({ path: 'artifacts/node-deletion-mobile-light.png' });
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(page).toHaveURL(/\/nodes$/);
  expect((await page.request.get(`/api/v1/nodes/${node.id}`)).status()).toBe(404);
});
