import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { ProbePair, ProbeTask } from '@traffic/contracts';

let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
async function select(page: Page, name: string, label: string) {
  const input = page.getByRole('combobox', { name: new RegExp(`${name}$`) }); await input.click();
  await page.getByText(label, { exact: true }).last().click();
  if (await input.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape');
}
test.beforeEach(async ({ page, context }) => {
  page.on('pageerror', e => { throw e; }); if (cookies.length) await context.addCookies(cookies);
  await page.goto('/');
  if (!cookies.length) { await page.getByLabel('管理员账号').fill('qa-admin'); await page.getByLabel('密码', { exact: true }).fill('local-browser-test-password'); await page.getByRole('button', { name: '登录后台' }).click(); }
  await expect(page.getByRole('heading', { name: '全局概览', exact: true })).toBeVisible();
  await page.goto('/probes');
  await expect(page.getByRole('heading', { name: '网络质量', exact: true })).toBeVisible(); cookies = await context.cookies();
});

test('two real Go Agents apply independent tasks and report local HTTP observations into browser history', async ({ page }) => {
  test.setTimeout(90000);
  await page.getByRole('button', { name: '新建探测' }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('真实本机 HTTP 联调');
  await select(page, '执行节点', '本机采集 · A'); await select(page, '执行节点', '本机采集 · B');
  await page.getByLabel('探测目标', { exact: true }).fill('http://127.0.0.1:18768/health');
  await page.getByLabel('探测间隔（秒）', { exact: true }).fill('15'); await page.getByLabel('启用探测', { exact: true }).click();
  await page.getByRole('button', { name: '保存探测任务' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => {
    const { pairs } = await (await page.request.get('/api/v1/probe-tasks')).json() as { pairs: ProbePair[] };
    return pairs.filter(p => p.task.name === '真实本机 HTTP 联调' && p.latest?.status === 'success' && p.extensions.applied_version === p.extensions.config_version).length;
  }, { timeout: 50000 }).toBe(2);
  const card = page.locator('article').filter({ hasText: '本机采集 · A → 真实本机 HTTP 联调' });
  await expect(card.getByText('扩展配置已应用', { exact: false })).toBeVisible();
  await card.getByRole('button', { name: '查看历史 / 多节点对比' }).click();
  await expect(page.getByLabel('本机采集 · A 探测历史')).toContainText('观测可用率');
  await expect(page.getByLabel('本机采集 · B 探测历史')).toContainText('100.0%');
  await page.reload(); await expect(page).toHaveURL(/probe_task=/); await expect(page.getByLabel('本机采集 · A 探测历史')).toBeVisible();
  const records = await (await page.request.get('http://127.0.0.1:18768/records')).json(); expect(records.hits).toBeGreaterThanOrEqual(2);
  await card.getByRole('button', { name: '停用探测' }).click();
  await expect(card.getByText('已停用', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '归档探测' }).click();
  await expect(card.getByText('已归档', { exact: true })).toBeVisible();
  await expect(page.getByLabel('本机采集 · A 探测历史')).toContainText('次有效执行');
});

test('probe editor survives refresh and restores focus at every target width in both themes', async ({ page }) => {
  test.setTimeout(90000); mkdirSync('artifacts', { recursive: true }); await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const light of [false, true]) {
    if (light) await page.getByRole('button', { name: '切换主题' }).click();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const trigger = page.getByRole('button', { name: '新建探测', exact: true }); await trigger.click();
      await page.getByLabel('任务名称', { exact: true }).fill('未保存探测输入');
      if (width === 1440 && !light) await page.waitForResponse(r => r.url().endsWith('/api/v1/probe-tasks') && r.request().method() === 'GET');
      await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue('未保存探测输入');
      expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(trigger).toBeFocused();
      if ([1440, 390].includes(width)) await page.screenshot({ path: `artifacts/probes-${width}-${light ? 'light' : 'dark'}.png`, fullPage: true, animations: 'disabled' });
    }
  }
});

test('mock multi-source history exposes coverage gaps and versioned samples, node link keeps the network tab', async ({ page }) => {
  const { tasks } = await (await page.request.get('/api/v1/probe-tasks')).json() as { tasks: ProbeTask[] };
  const task = tasks.find(t => t.name === '应用可用性 · 模拟结果')!;
  await page.goto(`/probes?probe_task=${task.id}&probe_minutes=360`);
  await expect(page.getByLabel('东京 · 核心节点 探测历史')).toContainText('覆盖率');
  const history = await (await page.request.get(`/api/v1/nodes/${task.node_ids[0]}/probe-history?task_id=${task.id}&minutes=360`)).json();
  expect(history.stats.coverage).toBeLessThan(100); expect(history.stats.p95_ms).toBeGreaterThanOrEqual(history.stats.p50_ms);
  expect(history.points.some((p: { latency_ms: number | null }) => p.latency_ms === null)).toBe(true);
  await page.getByLabel('东京 · 核心节点 探测历史').locator('summary').click();
  await expect(page.getByLabel('东京 · 核心节点 探测历史')).toContainText('v1');
  await page.getByLabel('东京 · 核心节点 探测历史').locator('summary').click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/probes-history-1440.png', fullPage: true, animations: 'disabled' });
  await page.locator('article').filter({ hasText: '东京 · 核心节点 →' }).getByRole('link', { name: '节点详情' }).click();
  await expect(page).toHaveURL(/tab=probes/); await expect(page.getByRole('tab', { name: '网络质量' })).toHaveAttribute('aria-selected', 'true');
});
