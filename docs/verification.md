# 验证记录

最后更新：2026-11-02；历史记录按各节日期保留。全部操作针对本地工作区或隔离的临时数据库；没有对现有 `trafficmon/traffic.db`、`trafficmon/settings.json` 执行迁移或写入，没有部署实际 VPS。

## 监控 M2-B / M3（2026-11-02）

在 M1/M2-A 基础上补齐剩余阶段。先保存 [设计](monitoring-m2b-m3-design.md) 与 [布局](monitoring-m2b-m3-layout.svg)，使用及恢复说明见 [指南](monitoring-m2b-m3-operations.md)。中心 v5、Agent v4，源码默认 1.3.0；基础协议仍为 v1，新采集默认关闭。

- `npm test`：**76 项通过**。新增 10 项覆盖诊断能力、严格空值/类型、独立 ACK、revision 去重、配置竞争/CSRF、低频样本连续性、未知保持、小时/天有效加权、迟到重算、先汇总再清理、v4→v5 失败回滚、资产去重、注册限时/次数/撤销及幂等、DST 与计费周期、最近一期报表去重与 CSV、容量预测的覆盖/清理重建。原 M1/M2-A 全部回归。
- `npm run typecheck` / `npm run build`：API、Web、contracts、脚本及浏览器用例检查与生产构建通过。新增图表保持动态加载；没有变更依赖或锁文件。
- `GOCACHE=/tmp/traffic-monitor-go-cache go test -race ./... -count=1`、`go vet ./...`：通过。新增分钟合并与重复低频采样、文件系统/进程身份、精确/缺失/错误 ACK、过期丢弃摘要、计数器首样/重置/断档、PSI、配置命令拒绝、固定 Docker GET/环境信息不持久化、旧中心一次回退及保留未确认历史；systemd/OpenRC 使用临时假命令分别模拟运行、停止、不可读和不支持。这不等于真实服务管理器运行验收。
- amd64 / arm64：`CGO_ENABLED=0 GOOS=linux GOARCH=... go build` 均通过，输出 `/tmp/traffic-agent-m2b-amd64` 与 `/tmp/traffic-agent-m2b-arm64`。amd64 用于隔离 QA 两个独立本机 Agent；arm64 未运行设备。
- `python3 tests/agent_resync_test.py`：**6 项通过**。新增 v4 诊断/工作负载的 SQL 与 JSON revision 一致重发、原独立游标保留。`python3 tests/install_agent_test.py`：**2 项通过**，覆盖架构/URL、校验、文件权限、已有安装保护与固定服务单元恢复。没有在真实 VPS 执行安装。
- `XDG_CACHE_HOME=/tmp/traffic-monitor-antd-cache antd lint apps/web/src --format json`：**0 问题、无跳过**。修复 Select 旧属性用法；所有新表单有独立 ID，防止跨表单标签聚焦错误。
- `QA_AGENT_BINARY=/tmp/traffic-agent-m2b-amd64 npm run test:e2e`：Chrome **完整 39 项通过，约 2.5 分钟**。新增 4 项包括诊断历史/URL/刷新保留输入、资产保存与私密注册、报表生成与导出链接、1440/1024/768/390/320px 深浅主题、两个真实本机 Agent 及当前 1.3.0 诊断能力/采集/7 流同步状态。最终 Agent 与页面收尾后，新增 4 项另做定向复核；最终 4 项复核全部通过（约 20 秒），截图等待图表 canvas 完成可见。
- 默认 `docker compose config --quiet` 与 `NOTIFICATION_KEY_PATH=/tmp/traffic-monitor-notification-key-check docker compose -f compose.yaml -f deploy/compose.notifications.yaml config --quiet` 均通过；后者只是占位路径配置检查，未创建生产密钥。
- 隔离 Docker smoke 通过：缓存 `linux-traffic-monitor:control` 仅作为运行时，只读挂载当前 API/Web 编译产物与 smoke 脚本，`--network none --read-only --user 1000:1000 --cap-drop ALL`，临时内存 `/data` 和 `/tmp`。验证 v5 初始化、页面资源、Cookie/CSRF、SSE、关闭状态的规则/探测/诊断/报表、短期注册、无通知密钥启动、套餐预览/保存和退出。不是完整 Dockerfile 重建或发布镜像验证。

代表性组合负载：

```bash
LOAD_SECONDS=15 LOAD_PROBES=1 LOAD_DIAGNOSTICS=1 node --import tsx scripts/monitoring-load.ts
```

50 模拟节点、500 个探测分配、432,000 条资源（30 天每 5 分钟一条）、504,000 条网卡分钟（7 天逐分钟）、59,025 条探测（约 2 小时）、100 个新指标流。测量 **15.74 秒 / 200 次上报**；上报 P95 **3.03ms**，总览 **337.23ms**，原资源/网卡历史 **52.07ms**，探测历史 **2.04ms**，诊断历史 **1.22ms**；6 帧 SSE、75 个事件。最后一次调度延迟约 1ms，结束尚有 150 个汇总脏桶和 75 条模拟待发送通知。并未排空，也未对长期汇总完整规模做生产容量承诺。这不是同硬件/数据的升级前后对照，不能据此声称增幅 ≤20%。

截图：[诊断手机深色](../artifacts/diagnostics-390-dark.png)、[诊断桌面浅色](../artifacts/diagnostics-1440-light.png)、[运行管理手机浅色](../artifacts/management-390-light.png)、[运行管理桌面浅色](../artifacts/management-1440-light.png)。均为隔离数据；图表缺口与陈旧状态按采样实际呈现，没有把模拟数据当成真实 VPS。

本地验收已经覆盖剩余功能；未执行提交、推送、发布或部署，未改用户库、配置或凭据。真实 VPS、生产数据库副本、长期 systemd/OpenRC、真实受限 Docker 代理、公网 HTTPS 通知、完整 Docker 镜像重建和 arm64 设备仍需目标环境验收。批量安装只做逻辑/文件保护测试；真实下载、系统账号、服务安装和断电恢复需单独演练。

## 监控 M2-A 网络探测（2026-11-02）

本阶段在 M1 工作区基础上增量实现。设计先保存至 [交互说明](monitoring-m2a-design.md) 和 [SVG 草图](monitoring-m2a-layout.svg)，使用、备份和恢复限制见 [网络探测指南](monitoring-m2a-operations.md)。中心为 SQLite v4，Agent 源码默认版本 1.2.0、SQLite v3，基础协议 v1。

- `npm test`：**66 项通过**，新增 8 项探测用例；覆盖旧 Agent、独立配置与错误、ACK、认证/CSRF、任务版本、每节点 10 项限制、历史/多来源去重、陈旧及旧版本结果、缺口/恢复、证书档位、迁移事务回滚，以及 HTTP 上报校验中的 null 保留。补充共享 fixtures 与导出 schema 检查通过。
- 上报接口单独关闭 Ajv body 类型强制转换；否则 `null` 证书时间会被转换成 `0`，产生假的证书到期事件，失败耗时也会被转为 `0` 后错误拒绝。修复经过真实 Fastify 请求校验层测试，并由 500 项探测负载复核；原 query 参数仍保持数值转换。
- `npm run typecheck` / `npm run build`：通过；API、Web、contracts、工具和浏览器类型检查及生产产物。`npm install --package-lock-only --ignore-scripts --offline` 核对依赖锁通过。新增声明直接使用的 `@fastify/ajv-compiler`，复用已有锁定版本，不升级其他依赖。
- `GOCACHE=/tmp/traffic-monitor-go-cache go test -race ./... -count=1`、`go vet ./...`：通过；后续补充探测离线重试用例再运行 `go test -race ./internal/monitor -run Probe -count=1` 通过。覆盖固定 DNS 地址、混合受限解析拒绝、敏感地址不被允许网段覆盖、HTTP 2xx/503/超时/不跟随重定向/限读正文、自签名 TLS 拒绝与证书证据、IPv6 TCP、ICMP 实际回环成功及注入 EPERM 的不支持状态、独立双 worker 不阻塞采集、取消、配置持久化失败、能力降级、缺失/不匹配 ACK、预算公平分配、7 天丢弃摘要和 v2→v3 迁移。ICMP 权限失败为注入验证，未在真实受限 VPS 上运行。
- amd64/arm64 使用 `CGO_ENABLED=0` 静态编译通过。amd64 产物用于临时浏览器 Agent；arm64 只输出 `/tmp/traffic-agent-m2a-arm64`，未进行设备运行验收。
- `python3 tests/agent_resync_test.py`：**5 项通过**。v3 探测重传更新 SQL 和 JSON 两处 revision，保留 sample_id/source_id、基线、累计和原游标；默认预览、停止确认、独立一致性备份及高水位保护均保留。中心已有相同样本时提高 revision 仍只保留一条结果；未知任务/分配版本不会被假装恢复。
- `XDG_CACHE_HOME=/tmp/traffic-monitor-antd-cache antd lint apps/web/src --format json`：**0 问题，无跳过文件**。
- `npx playwright test`：最终 Chrome **完整 35 项通过，约 2.2 分钟**。新增 **3 项**通过真实页面为两个独立本机 Go Agent 下发探测、等待扩展确认与本地 HTTP 成功结果、历史对比、停用/归档仍可查询历史；另验证模拟缺口与统计、节点网络页签；1440/1024/768/390/320px 深浅主题、URL 筛选、未保存输入和抽屉键盘焦点恢复。旧版用例的 Agent 版本断言同步为 1.2.0，原功能不受影响。
- 隔离 Docker 启动通过：缓存 `linux-traffic-monitor:control` 作为运行时，只读挂载当前 API/Web 产物及 smoke 脚本；`--network none`、UID/GID 1000、只读根目录、临时内存 `/data` 与 `/tmp`。管理员入口、SQLite v4 迁移、静态页面、认证、SSE、关闭的规则/探测保存、无通知密钥运行、套餐预览/保存及退出通过。这不是完整 Dockerfile 重新构建或新发布镜像验收。

### M2-A 代表性负载

命令：`LOAD_PROBES=1 LOAD_SECONDS=15 node --import tsx scripts/monitoring-load.ts`。50 模拟节点，每节点 10 个任务，共 500 分配；432,000 条资源记录（30 天、每 5 分钟）、504,000 条网卡分钟记录（7 天）、59,364 条探测记录（约 2 小时）。实际测量 15.81 秒、200 次上报、6 帧 SSE：上报 P95 **2.88ms**、总览 **327.83ms**、原历史 **56.08ms**、探测历史 **2.28ms**。75 个既有 M1 事件，模拟通知 75 条仍处于待发送；没有宣称队列排空。

首次负载发现 500 个由 null→0 转换引起的假证书事件，已修复并复测消失。以上数据使用临时 SQLite、Fastify inject 和进程内模拟通知，不包含真实公网 RTT；没有同硬件/同数据的升级前后对照，也没有 50 节点满量 7 天探测历史或独立调度延迟测量，因此不声称 ≤20% 增幅或生产容量达标。

截图：[手机深色](../artifacts/probes-390-dark.png)、[手机浅色](../artifacts/probes-390-light.png)、[桌面深色](../artifacts/probes-1440-dark.png)、[桌面浅色](../artifacts/probes-1440-light.png)、[多来源历史](../artifacts/probes-history-1440.png)。均为隔离数据，沿用 `artifacts/` 忽略规则。

本阶段没有提交、推送、发布、变更真实服务/凭据或迁移用户库；实际 VPS、systemd/OpenRC、真实公网 HTTPS 目标、生产副本回退和 arm64 设备仍需验证。在该阶段记录时 M2-B/M3 尚未实施；后续交付见本文件最上方新记录。

## 监控 M1-A / M1-B（2026-11-02）

本节保留第一批 M1 的历史实际结果；M2-A 的当前结果见上文。M1 只操作本地工作区与临时数据库，没有部署或迁移现有用户数据。完成范围见 [升级进度](monitoring-upgrade-progress.md)，使用及备份见 [M1 指南](monitoring-m1-operations.md)。

- `npm test`：最终 **58 项全部通过**。覆盖原上报/认证/配置/SSE/历史，大整数，v1/v2→v3 数据迁移及失败回滚、凭据摘要/会话保留、资源新鲜度/重复 revision/补传/时钟异常、持续时间/滞回/恢复/重启/停用/范围变化、确认、静默、维护和通知。
- 通知覆盖最多 2 并发与任务防重入、退避和 429 上限、408/4xx/5xx、稳定阶段幂等键（恢复摘要不会沿用已尝试触发的键）、远端接收后本地提交失败、首发失败及请求在途时恢复的摘要合并、取消多余恢复、活跃事件投递证据保留、密钥缺失/错误、加密配置重新打开、脱敏、试发/重试限流。实际本地 HTTP 验证成功、超时及不跟随重定向；临时自签名 HTTPS 服务验证证书被拒绝。
- 套餐覆盖四种口径、单网卡跨分钟汇总超过 64 位、跨档合并、周期与策略版本去重、过去周期补传、预览并发冲突、31 日/时区修改、固定计费网卡，以及首报旧配置导入重算。原周期测试继续覆盖短月、闰年、夏令时。预测验证自然日覆盖不足、零速率、当前采样异常、已超额和 max 分方向投影；纽约夏令时结束日按 25 小时计算。
- `python3 tests/agent_resync_test.py`：**4 项通过**。另外 API 测试实际使用 SQLite Backup API 保存中心库，再恢复该备份，执行独立 Python 工具重新分配 v2 Agent 数据 revision，向恢复的中心重复上报，核对 500 字节按覆盖保留为 500、没有叠加；source_id、累计和基线保留。仅用临时库演练，不支持未经核实的旧 Agent 库恢复。
- `npm run typecheck`、`npm run build`：通过；涵盖 API、Web、contracts、脚本及浏览器用例。`node --import tsx scripts/export-schema.ts` 已导出中心监控 schema；测试核对导出内容与 TypeBox 一致，Agent `report.schema.json` 与旧协议保持一致。
- `XDG_CACHE_HOME=/tmp/traffic-monitor-antd-cache antd lint apps/web/src --format json`：**0 问题，无跳过文件**。
- `npm run test:e2e`：Chrome **完整 32 项通过，约 1.7 分钟**。新增 4 项通过真实页面/API 完成规则创建→本地 Webhook 试发→触发→确认→恢复、套餐编辑→预览→保存→精确核对、维护创建/编辑/取消及界面验收。原有 28 项继续覆盖两个独立本机 Go Agent、配置确认、历史筛选、SSE、登录、刷新和主题。后端收尾修改后又运行 `npx playwright test tests/browser/monitoring.spec.ts`，新增 4 项通过（约 38 秒）。
- 新页面在 **1440/1024/768/390/320px** 下检查深浅主题无页面横向溢出；规则纵向表单、URL 筛选/页签、自动刷新保留未保存输入、减少动画和抽屉焦点恢复通过。焦点恢复不依赖动画结束回调。
- 在 `agent` 目录执行 `GOCACHE=/tmp/traffic-monitor-go-cache go test -race ./... -count=1`、`GOCACHE=/tmp/traffic-monitor-go-cache go vet ./...`：通过。未改 Agent 采集、存储或协议源码。
- `CGO_ENABLED=0 GOOS=linux GOARCH=amd64/arm64 GOCACHE=/tmp/traffic-monitor-go-cache go build -buildvcs=false -o /tmp/traffic-monitor-m1-agent-<架构> ./cmd/traffic-agent`：分别执行并通过；arm64 未运行设备验证。
- `docker compose config --quiet` 和带 `deploy/compose.notifications.yaml` 的配置检查：通过，覆盖文件只使用临时密钥路径进行解析检查。
- 隔离 Docker 启动：使用已有 `linux-traffic-monitor:control` **作为缓存运行时**，只读挂载本次 API/Web 编译产物；非 root、只读根文件系统、`--network none` 和临时 `/data`/`/tmp`。编译后的管理员入口、中心启动、SQLite v3、静态页面、鉴权、SSE、无通知密钥运行、关闭的告警规则、套餐预览/保存及退出登录通过。**这不是完整 Dockerfile 的重新构建，也不是新发布镜像验收。**

### M1 代表性负载

命令：`LOAD_SECONDS=45 node --import tsx scripts/monitoring-load.ts`。

| 数据或结果 | 实际值 |
| --- | --- |
| 模拟节点 / 上报间隔 | 50 / 5 秒 |
| 资源记录 | 432,000 条；覆盖 30 天，每 5 分钟一条 |
| 网卡流量 | 504,000 条；覆盖 7 天，逐分钟 |
| 测量阶段 | 45.68 秒，500 次上报成功 |
| 上报 P95 | 0.65ms |
| 总览 P95 | 308.83ms |
| 30 天历史查询 P95 | 50.76ms |
| SSE / 告警 | 12 帧 / 75 个事件 |
| 模拟通知 | 每条先 503 再 204；结束时 30 条成功、45 条仍在持久队列 |

使用临时 SQLite、Fastify inject、进程内 SSE 和模拟通知；不含公网 RTT、TLS 成功投递或真实 VPS。资源记录为代表性 5 分钟采样，不是满量 30 天分钟记录；尚无同硬件/同数据集的升级前后对照，也未单独测量调度延迟，因此没有宣称上报增幅 ≤20% 或生产容量目标通过。队列没有在测量结束前全部排空。

### 本次截图

- 告警：[桌面深色](../artifacts/monitoring-alerts-1440-dark.png) · [桌面浅色](../artifacts/monitoring-alerts-1440-light.png) · [手机深色](../artifacts/monitoring-alerts-390-dark.png) · [手机浅色](../artifacts/monitoring-alerts-390-light.png)。
- 套餐：[桌面深色](../artifacts/monitoring-quota-1440-dark.png) · [桌面浅色](../artifacts/monitoring-quota-1440-light.png) · [手机深色](../artifacts/monitoring-quota-390-dark.png) · [手机浅色](../artifacts/monitoring-quota-390-light.png)。
- 渠道：[桌面深色](../artifacts/monitoring-channels-1440-dark.png) · [桌面浅色](../artifacts/monitoring-channels-1440-light.png) · [手机深色](../artifacts/monitoring-channels-390-dark.png) · [手机浅色](../artifacts/monitoring-channels-390-light.png)。

截图包含隔离测试数据；`artifacts/` 沿用仓库忽略规则。本次尚未验证真实公网 Webhook 接收、生产密钥备份、实际用户库迁移、真实 VPS/systemd/OpenRC、arm64 设备运行，以及完整发布镜像构建。M2/M3 未实施。

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
