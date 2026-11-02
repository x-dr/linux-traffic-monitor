import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { NodeView, QuotaView } from '@traffic/contracts';

let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
async function select(page: Page, name: string, label: string) {
  const input = page.getByRole('combobox', { name });
  await input.click();
  await page.getByText(label, { exact: true }).last().click();
  if (await input.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape');
}
test.beforeEach(async ({ page, context }) => {
  page.on('pageerror', error => { throw error; });
  if (cookies.length) await context.addCookies(cookies);
  await page.goto('/');
  if (!cookies.length) {
    await page.getByLabel('管理员账号').fill('qa-admin'); await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password');
    await page.getByRole('button', { name: '登录后台' }).click();
  }
  await expect(page.getByRole('heading', { name: '全局概览' })).toBeVisible(); cookies = await context.cookies();
});

test('rule creation, actual local test webhook, firing, acknowledge and recovery complete in the browser', async ({ page }) => {
  test.setTimeout(60000);
  await page.request.post('http://127.0.0.1:18767/control', { data: { cpu: 95 } });
  await page.goto('/settings'); await page.getByRole('button', { name: '新增 Webhook', exact: true }).click();
  await page.getByLabel('渠道名称').fill('浏览器隔离 Webhook'); await page.getByLabel('Webhook URL').fill('http://127.0.0.1:18767/hook');
  await page.getByRole('button', { name: '保存渠道' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const channel = page.locator('article').filter({ hasText: '浏览器隔离 Webhook' }).first();
  await channel.getByRole('button', { name: '测试通知' }).click();
  await expect(page.getByLabel('通知投递记录').getByText('成功', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await page.goto('/alerts?tab=rules'); await page.getByRole('button', { name: '新建规则' }).click();
  await select(page, '规则模板', 'CPU 高占用'); await page.getByLabel('规则名称').fill('浏览器 CPU 告警');
  await select(page, '节点范围', '指定节点'); await select(page, '指定节点', '告警联调 · 模拟节点');
  await expect(page.getByRole('status')).toContainText('匹配 1 台');
  await page.getByLabel('异常持续（秒）').fill('0'); await page.getByLabel('恢复持续（秒）').fill('0');
  await expect(page.getByRole('status')).toContainText('匹配 1 台');
  await select(page, '通知渠道', '浏览器隔离 Webhook'); await page.getByLabel('启用规则').click();
  await expect(page.getByRole('status')).toContainText('匹配 1 台');
  await page.getByRole('button', { name: '保存规则' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '事件', exact: true }).click();
  await page.getByRole('button', { name: '浏览器 CPU 告警', exact: true }).click({ timeout: 15000 });
  const detail = page.getByRole('dialog', { name: '事件详情' });
  await detail.getByRole('button', { name: '确认事件' }).click(); await expect(detail.getByRole('button', { name: '确认事件' })).toBeDisabled();
  await expect(detail.getByText('成功', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  const event = new URL(page.url()).searchParams.get('event');
  await page.request.post('http://127.0.0.1:18767/control', { data: { cpu: 20 } });
  await expect(detail.getByText('已恢复', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => {
    const records = (await (await page.request.get('http://127.0.0.1:18767/records')).json()).deliveries as { event_id: string; phase: string }[];
    return records.filter(r => r.event_id === event).map(r => r.phase);
  }).toEqual(['trigger', 'recovery']);
  await page.keyboard.press('Escape'); await select(page, '告警状态筛选', '全部事件'); await page.reload(); await expect(page).toHaveURL(/state=all/);
});

test('traffic policy edit, preview and save match exact center records and preserve existing totals', async ({ page }) => {
  const nodes: NodeView[] = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const node = nodes.find(n => n.name === '东京 · 核心节点')!;
  await page.goto(`/nodes/${node.id}?tab=quota`); await page.getByRole('button', { name: '编辑套餐' }).click();
  await page.getByLabel('套餐额度').fill('100'); await select(page, '输入单位', 'GiB');
  await select(page, '计费方向', '周期上传与下载的较大值'); await page.getByLabel('启用套餐').click();
  await page.getByRole('button', { name: '预览重算' }).click();
  await expect(page.getByRole('heading', { name: '重算预览' })).toBeVisible();
  await page.getByRole('button', { name: '确认保存套餐' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const quota: QuotaView = (await (await page.request.get(`/api/v1/nodes/${node.id}/quota`)).json()).quota;
  const total = (await (await page.request.get(`/api/v1/nodes/${node.id}`)).json()).traffic;
  expect(total).toEqual(node.traffic); expect(quota.policy.direction).toBe('max');
  expect(quota.billed_bytes).toBe(String(BigInt(quota.rx_bytes) > BigInt(quota.tx_bytes) ? BigInt(quota.rx_bytes) : BigInt(quota.tx_bytes)));
  await expect(page.getByLabel('流量套餐').getByText(`${quota.billed_bytes} / ${quota.policy.quota_bytes} 字节`)).toBeVisible();
  await expect(page.getByText(/基于中心已收到记录估算/)).toBeVisible();
  await page.reload(); await expect(page).toHaveURL(/tab=quota/); await expect(page.getByText('计费流量 · 上传与下载的较大值')).toBeVisible();
});

test('new screens and vertical rule editing fit all target widths, preserve keyboard focus and both themes', async ({ page }) => {
  test.setTimeout(90000); mkdirSync('artifacts', { recursive: true });
  const nodes: NodeView[] = (await (await page.request.get('/api/v1/nodes')).json()).nodes;
  const node = nodes.find(n => n.name === '东京 · 核心节点')!;
  await page.goto('/alerts?tab=rules'); await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const light of [false, true]) {
    if (light) await page.getByRole('button', { name: '切换主题' }).click();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: '新建规则' }).click();
      await page.getByLabel('规则名称').fill('未保存输入保持');
      if (width === 1440 && !light) await page.waitForResponse(response => response.url().endsWith('/api/v1/alert-rules') && response.request().method() === 'GET');
      await expect(page.getByLabel('规则名称')).toHaveValue('未保存输入保持');
      await expect(page.getByRole('button', { name: '保存规则' })).toBeVisible();
      expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '新建规则' })).toBeFocused();
      if (width === 1440 || width === 390) await page.screenshot({ path: `artifacts/monitoring-alerts-${width}-${light ? 'light' : 'dark'}.png`, fullPage: true, animations: 'disabled' });
      for (const [name, path, heading] of [['quota', `/nodes/${node.id}?tab=quota`, '流量套餐'], ['channels', '/settings', '通知渠道']] as const) {
        await page.goto(path); await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 1440 || width === 390) await page.screenshot({ path: `artifacts/monitoring-${name}-${width}-${light ? 'light' : 'dark'}.png`, fullPage: true, animations: 'disabled' });
      }
      await page.goto('/alerts?tab=rules');
    }
  }
  await page.goto('/settings'); await expect(page.getByRole('heading', { name: '通知渠道', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('maintenance window creation, edit and cancellation use the API and restore invoking controls', async ({ page }) => {
  await page.goto('/alerts?tab=maintenance'); await page.getByRole('button', { name: '新建维护窗口' }).click();
  await page.getByLabel('维护名称').fill('浏览器维护窗口'); await select(page, '节点范围', '分组'); await page.getByLabel('分组或标签').fill('隔离维护测试');
  await page.getByRole('button', { name: '保存维护' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '浏览器维护窗口' })).toBeVisible();
  await page.getByRole('button', { name: '编辑维护' }).click(); await page.getByLabel('维护名称').fill('已修改维护窗口');
  await page.getByRole('button', { name: '保存维护' }).click(); await expect(page.getByRole('heading', { name: '已修改维护窗口' })).toBeVisible();
  await page.getByRole('button', { name: '取消维护' }).click(); await expect(page.getByRole('heading', { name: '已修改维护窗口' })).toHaveCount(0);
});
