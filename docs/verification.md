# 验证记录

日期：2026-10-30。全部操作针对本地工作区或隔离的临时数据库；没有对现有 `trafficmon/traffic.db`、`trafficmon/settings.json` 执行迁移或写入，没有部署实际 VPS。

## 网卡与硬盘读写历史（1.1.0）

- 设计文档与页面草图先保存于 [history-io-design.md](history-io-design.md) 和 [history-io-layout.svg](history-io-layout.svg)，随后完成 Go 采集、协议、数据库迁移、历史 API 和节点详情页面。
- 网卡历史支持全部/单网卡、速率/流量、区间精确累计；磁盘历史支持全部/单整盘、读写曲线和区间累计。范围为 1/6/24 小时、7/30 天，可选自动、小时、天（UTC）聚合，筛选随 URL 保留。
- 中心和 Agent 的 v1→v2 增量迁移均使用隔离数据库验证；原有节点、会话、采集源和网络记录保留。旧 Agent 的上报仍可接收，旧数据没有被补造为磁盘历史。
- `npm test`：26 项通过，新增覆盖网卡/磁盘筛选、精确大整数、重复与乱序、跨桶聚合、空缺与零、校验与事务回滚、保留策略及 v1 数据库迁移。
- `GOCACHE=/tmp/traffic-monitor-go-cache go test -race ./... -count=1` 和 `go vet ./...`：通过。新增磁盘测试覆盖跨分钟整数分摊、首次/空闲采样、系统重启与计数器归零、不可读后恢复、身份变化、间断、溢出回滚、严格 ACK、并发后续采样、256 条分页和迁移；未报告数据竞争。
- `npm run typecheck`、`npm run build`：通过。最终页面调整另经前端构建通过；`NodeDetail.tsx`、`NodeHistory.tsx`、`TrendChart.tsx` 的 Ant Design CLI 检查均为 0 问题。
- `npx playwright test`：最终完整回归 28 项全部通过，约 1 分钟；新增 6 项覆盖网卡/磁盘筛选、速率/流量、UTC 天聚合、URL 刷新保留、旧 Agent 与设备空状态、HTTP 503 后手动重试、键盘选择及两个真实本机 Agent 的磁盘上报。1440 / 768 / 390 / 320px 下验证深浅主题均无页面横向溢出。
- 浏览器累计量断言直接核对页面实际使用的响应，避免两次独立请求跨分钟时的滚动窗口差异；手动重试用例隔离 SSE 自动刷新，保证恢复由按钮触发。
- Go Agent 1.1.0 的 linux/amd64 与 linux/arm64 静态构建通过；arm64 未执行设备运行验证。
- 两个独立本机 Agent 的真实磁盘计数器、快照速度、分钟补传与中心历史接口已完成浏览器集成验证。两个进程共用同一台执行主机，不代表两台真实 VPS。
- 此次未执行 Docker 镜像构建、生产部署、systemd 安装或现有用户库迁移。测试 HTTP 服务和 Agent 使用临时凭据与独立临时目录。

效果图：[桌面深色](../artifacts/history-1440-dark.png) · [桌面浅色](../artifacts/history-1440-light.png) · [手机深色](../artifacts/history-390-dark.png) · [手机浅色](../artifacts/history-390-light.png)。截图包含隔离测试数据。

## VPS 监控列表调整

- 参考监控表格布局，节点名位于第一列，随后显示状态、月下载/上传、运行时长、负载、实时网络、累计下载/上传，以及 CPU、内存和根分区进度条。
- 点击节点旁的箭头可展开系统、内存、Swap、磁盘、网卡和流量统计周期；支持键盘操作。手机使用卡片和可展开详情，保留搜索、分组、状态筛选和完整详情入口。
- 离线、停用、归档与待接入节点不显示实时资源百分比；陈旧采样使用虚线进度条并标明最后采样。累计流量保留，缺失资源显示 `—`。刷新失败保留已有数据和筛选条件。
- `npm run typecheck`：API、前端、协议、脚本与浏览器用例全部通过。
- `npm run build -w @traffic/web`：前端生产构建通过。
- `antd lint apps/web/src/Nodes.tsx --format json` 与 `antd lint apps/web/src/NodeTable.tsx --format json`：均为 0 问题；CLI 缓存使用可写的 `/tmp/traffic-monitor-antd-cache`。
- `npm run test:e2e`：Chrome 12 项全部通过，耗时 34.6 秒。新增覆盖键盘展开收起、刷新保留展开和搜索状态、按字节排序、离线数据展示、指标缺失和刷新失败。
- 1920px 下检查深浅主题，1440/1024/768/600/390/320px 下检查列表布局，均无页面横向溢出；手机可展开运行详情，并验证主题持久化与减少动态效果。
- 验收使用临时中心数据库、3 个预置测试节点和 2 个独立本机 Go Agent；缺失指标与 HTTP 503 场景使用浏览器响应替换。本次没有修改 API 或 Agent，没有重跑 API、Go、Docker、负载或真实 VPS 部署检查。

## 此前清理复核

- `npm test`：18 项通过；`npm run typecheck` 和 `npm run build` 均通过。
- `go test -race ./...`：通过，覆盖旧库迁移和日历周期。使用 `/tmp` 下的可写构建缓存，并允许测试监听本机临时端口。
- `docker compose config --quiet`：中心配置检查通过。
- 项目源码和文档中已无被移除实现的入口、运行环境或部署引用；17 个本地文档链接及迁移章节锚点检查通过。
- `trafficmon/traffic.db` 和 `trafficmon/settings.json` 清理前后 SHA-256 一致，未执行实际数据迁移。
- 本次未重跑浏览器验收、交叉编译、负载测试或镜像构建与启动检查，下方对应条目为此前记录。

## 此前已通过

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | API、前端、共享协议、脚本及浏览器用例类型检查通过 |
| `npm test` | 18 项通过 |
| `go test -race ./...` | 16 组通过，含月周期子场景；无数据竞争报告 |
| `npm run build` | 前端生产构建和 API 编译通过，依赖已锁定 |
| `antd lint apps/web/src --format json` | 0 问题，未跳过文件 |
| `npm run test:e2e` | Chrome 浏览器 8 项通过，约 29 秒 |
| Go 交叉编译 | linux/amd64、linux/arm64 均成功，CGO_ENABLED=0，确认静态链接 |
| Compose 配置 | 中心配置通过解析 |
| Docker 构建 | `linux-traffic-monitor:control` 镜像构建成功 |
| Docker 实际启动 | 临时容器内通过编译后的管理员 CLI、正式入口、SQLite、静态资源、详情路由、登录、CSRF 写入、SSE 和退出登录 |
| 开发启动 | 实际启动两个工作区开发服务，验证数据库相对路径、Vite 资源和代理、登录、CSRF 与 SSE |

中心测试覆盖：凭据隔离、CSRF、来源限制、登录限流、密码变更撤销会话、重复与乱序上报、64 位整数、事务失败回滚、采集源替换拒绝、离线状态、采集停滞、配置版本、资源保留、历史缺口、归档恢复、中心重启、SSE 多连接及会话撤销、小时聚合、日历周期与夏令时。

Go 测试覆盖：旧库迁移预览与正式迁移、目标覆盖保护、源文件保留、短月和闰年、夏令时、重启续算、计数器归零、网卡切换、不可读后恢复、溢出回滚、稳定源 ID、同步游标持久化、并发采集时确认不丢更新、分钟聚合、资源清理、共享协议、文件系统筛选、HTTP 失败/超时重试和配置持久化失败。

浏览器验收环境使用 3 个明确的测试节点和 **2 个独立 Go Agent 进程**。两进程在同一台本机 Linux 运行，分别使用独立 SQLite、配置与凭据，实际完成上报和新配置确认；不是两台真实 VPS。

浏览器 8 项覆盖登录、总览、搜索分组、详情直达与刷新、时间范围、配置下发确认、创建节点、SSE 重连、退出登录，以及 1440/768/390px 下的布局、导航和主题持久化。验证了手机列表和详情没有页面横向溢出。

## 50 节点定时上报

命令：

```bash
LOAD_SECONDS=60 node --import tsx scripts/load-test.ts
```

- 50 个模拟 Agent，每 5 秒上报一次，运行 60.05 秒。
- 完成 650 次上报，全部成功。
- 平均处理 0.45 ms，P95 0.59 ms，最大 7.65 ms。
- 同时检查总览、30 天范围查询、SSE 快照及清理任务。

该测试使用本地临时 SQLite、Fastify inject 和进程内 SSE 接收端，不包含公网网络时延、TLS 开销，也没有填满 50 台 VPS 的全部 30 天历史。真实 HTTP SSE 由浏览器与 Docker 启动检查分别验证。上述数字不能直接作为生产容量承诺。

## 浏览器截图

- [VPS 表格 · 浅色](../artifacts/vps-nodes-desktop-light.png)
- [VPS 表格 · 深色](../artifacts/vps-nodes-desktop-dark.png)
- [VPS 手机卡片与展开详情](../artifacts/vps-nodes-mobile.png)
- [VPS 平板列表](../artifacts/vps-nodes-tablet.png)
- [桌面总览](../artifacts/desktop-overview.png)
- [桌面详情](../artifacts/desktop-detail.png)
- [手机总览](../artifacts/mobile-overview.png)
- [手机节点列表](../artifacts/mobile-nodes.png)
- [手机详情](../artifacts/mobile-detail.png)
- [平板总览](../artifacts/tablet-overview.png)

截图包含临时测试数据和本机 Agent 指标，不代表用户实际 VPS。`artifacts/` 默认忽略版本管理；重新运行浏览器验收可生成。

## 验证边界

- 未执行真实 VPS 安装、systemd 常驻运行、公网 HTTPS 证书接入及生产历史迁移。
- arm64 只完成交叉编译，未在真实 arm64 设备运行。
- Docker 启动检查使用非 root 用户、只读根文件系统和内存临时数据目录，不挂载现有数据，不启动实际部署服务。
- 浏览器和开发检查服务已在完成后关闭，临时账号、凭据和数据库已清理。
- 工作区没有可用的完整 Git 元数据；Go 使用 `-buildvcs=false` 构建，Docker 的 Git 元数据提示不影响镜像产物。

部署和迁移命令见 [运行指南](operations.md)。
