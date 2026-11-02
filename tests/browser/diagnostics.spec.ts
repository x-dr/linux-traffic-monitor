import { test, expect } from '@playwright/test';
async function login(page:import('@playwright/test').Page){await page.goto('/overview');await page.getByLabel('管理员账号').fill('qa-admin');await page.getByLabel('密码',{exact:true}).fill('local-browser-test-password');await page.getByRole('button',{name:'登录后台',exact:true}).click();await expect(page.getByRole('heading',{name:'全局概览',exact:true})).toBeVisible();}
async function nodeID(page:import('@playwright/test').Page){return await page.evaluate(async()=>{const {nodes}=await (await fetch('/api/v1/nodes')).json();return nodes.find((n:{name:string})=>n.name==='诊断验收节点').id as string;});}
test('diagnostic history, URL state, config preservation, workloads and long-term history',async({page})=>{
 await login(page);const id=await nodeID(page);await page.goto(`/nodes/${id}?tab=diagnostics&diag_object=cpu&diag_metric=iowait_percent`);
 await expect(page.getByRole('heading',{name:'系统诊断历史'})).toBeVisible();await expect(page.getByRole('img',{name:'iowait_percent 指标历史趋势图'})).toBeVisible();
 await page.getByLabel('服务白名单（最多 10 项）').fill('keep-unsaved.service');await page.waitForTimeout(5500);await expect(page.getByLabel('服务白名单（最多 10 项）')).toHaveValue('keep-unsaved.service');
 await page.reload();await expect(page.getByLabel('诊断对象')).toBeVisible();await expect(page).toHaveURL(/diag_object=cpu/);
 await page.goto(`/nodes/${id}?tab=workloads`);await expect(page.getByRole('heading',{name:'容器与重点进程'})).toBeVisible();await expect(page.getByLabel('进程名称白名单（最多 20 项）')).toHaveValue('nginx');
 await page.goto(`/nodes/${id}?tab=long-history`);await expect(page.getByRole('heading',{name:'资源与磁盘长期历史'})).toBeVisible();await expect(page.getByLabel('长期历史范围')).toBeVisible();
});
test('assets, private short-lived registration and idempotent scheduled report export',async({page})=>{
 await login(page);const id=await nodeID(page);await page.goto(`/nodes/${id}?tab=asset`);await page.getByLabel('供应商',{exact:true}).fill('浏览器验收供应商');await page.getByRole('button',{name:'保存资产',exact:true}).click();await expect(page.getByText('资产已保存，到期提醒已重算')).toBeVisible();await page.reload();await expect(page.getByLabel('供应商',{exact:true})).toHaveValue('浏览器验收供应商');
 await page.goto('/management');await expect(page.getByRole('heading',{name:'中心诊断'})).toBeVisible();await page.getByRole('button',{name:'创建短期凭据'}).click();await expect(page.getByLabel('一次性显示注册令牌')).toBeVisible();await page.getByRole('button',{name:'隐藏并清除'}).click();await expect(page.getByLabel('一次性显示注册令牌')).toHaveCount(0);
 await page.getByRole('button',{name:'新建报表',exact:true}).click();await page.getByLabel('报表名称').fill('浏览器日报');await page.getByRole('switch',{name:'启用定时任务'}).click();await page.getByRole('button',{name:'保存报表任务'}).click();await expect(page.getByText('浏览器日报',{exact:true})).toBeVisible();await page.getByRole('button',{name:'生成最近一期'}).click();await expect(page.getByRole('link',{name:'下载 CSV'}).first()).toBeVisible();
});
test('diagnostic and management layouts at 1440/1024/768/390/320 with both themes',async({page})=>{
 await login(page);const id=await nodeID(page);
 for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:1000});for(const theme of ['dark','light']){await page.evaluate(v=>{localStorage.setItem('observatory-theme',v);document.documentElement.dataset.theme=v;},theme);for(const route of [`/nodes/${id}?tab=diagnostics`,'/management']){await page.goto(route);await expect(page.getByRole('heading',{name:route==='/management'?'中心诊断':'系统诊断历史'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);if(route!=='/management')await expect(page.getByRole('img',{name:'iowait_percent 指标历史趋势图'}).locator('canvas').first()).toBeVisible();if(width===390||width===1440)await page.screenshot({path:`artifacts/${route==='/management'?'management':'diagnostics'}-${width}-${theme}.png`,fullPage:true});}}}
});
test('current Go Agent negotiates diagnostics and reports real local samples with sync health',async({page})=>{
 await login(page);
 await expect.poll(async()=>page.evaluate(async()=>{const {nodes}=await(await fetch('/api/v1/nodes')).json();const node=nodes.find((n:{name:string})=>n.name==='本机采集 · A');if(!node)return false;const view=await(await fetch(`/api/v1/nodes/${node.id}/diagnostics`)).json();return node.snapshot?.agent_version==='1.3.0'&&view.supported&&view.latest.some((o:{object:string;fresh:boolean})=>o.object==='cpu'&&o.fresh)&&view.sync?.streams.length===7;}),{timeout:20000}).toBe(true);
});
