# Linux Traffic Monitor

集中查看多台 Linux VPS 的资源与流量。中心采用 **React 19 + TypeScript + Ant Design 6**、**Fastify 5 + SQLite**，各 VPS 使用 **Go Agent** 采集并通过 HTTPS 主动上报，无需为 Agent 开放入站端口。

项目由多 VPS 管理中心和 Go Agent 组成，二者使用独立数据路径。已有单机流量历史可通过 Agent 的迁移命令导入。

## 功能

- **全局概览**：在线节点数、总上下行速率、资源排行、异常节点、本周期和累计流量。
- **节点管理**：名称、分组、标签、搜索、状态筛选、排序分页；停用、归档和恢复均保留历史。
- **资源监控**：CPU、内存、Swap、负载、磁盘容量、磁盘读写速度、主机信息、运行时长和网络速率。
- **历史趋势**：1 / 6 / 24 小时、7 / 30 天；支持自动、小时和天（UTC）聚合。网卡可单独筛选，切换速率/流量并查看区间下载、上传及合计；磁盘可单独筛选并查看历史读写速度和区间读写量。筛选保存在页面 URL 中，刷新后保留。缺失样本保留为空缺，资源和磁盘分钟记录保留 30 天，流量分钟记录和累计值长期保存。
- **系统诊断**：容量/inode 历史、CPU iowait/steal、PSI、IOPS/等待、TCP 与服务状态，按指标采样时间判定新鲜度；独立补传与同步积压诊断。
- **运行管理**：白名单进程与受限代理下的 Docker 只读监控、资产到期提醒、短期批量接入、小时/天长期汇总、时区定时报表和 CSV 导出。新采集默认关闭。
- **流量周期**：按节点设置网卡、IANA 时区及每月起始日和时间，查看当前周期、上一周期与累计下载/上传。
- **实时与补传**：网络每秒采样，资源采集和上报每 5 秒执行；浏览器通过 SSE 接收状态。断网时本地保存，恢复后分批补传，重复上报不会重复累计。
- **配置下发**：中心按版本下发监控配置，页面显示待应用、已应用或失败；Agent 持久化失败时继续使用原配置。
- **登录与界面**：单管理员、会话 Cookie、CSRF 校验、登录限流；中文界面、深浅主题及手机和平板布局。

中心超过 15 秒未收到上报，或采样数据超过 15 秒未更新时标为“数据陈旧”；超过 45 秒未收到上报标为“离线”。仅在线节点计入总实时速率。

相关文档：[部署指南（Docker + Nginx）](docs/deployment.md) · [运行与迁移指南](docs/operations.md) · [升级设计方案](docs/multi-vps-upgrade-plan.md) · [已有验证记录与边界](docs/verification.md)。

网卡与磁盘历史的页面布局和统计口径见 [历史监控设计](docs/history-io-design.md)。

告警、流量额度、网络探测及系统诊断的分阶段范围见 [新功能升级方案](docs/monitoring-upgrade-plan.md)。M1-A/M1-B、M2-A、M2-B 与 M3 已完成本地实现；当前交付、验证与待办见 [升级进度](docs/monitoring-upgrade-progress.md)，使用和备份说明见 [M1 指南](docs/monitoring-m1-operations.md) 、[网络探测指南](docs/monitoring-m2a-operations.md) 与 [系统诊断及运行管理指南](docs/monitoring-m2b-m3-operations.md)。

## 项目结构

```text
apps/web/          React 管理后台
apps/api/          Fastify 中心 API、登录与 SQLite 存储
packages/contracts/ 共享协议、JSON Schema 与样例
agent/             Go 采集、存储、上报与迁移程序
deploy/            Nginx 站点配置、Go Agent systemd / OpenRC 服务
scripts/           浏览器验收服务、负载测试与 Docker 启动检查
docs/              设计、运维与验证文档
```

## 快速开始：本地开发

要求 **Node.js 24+** 和 npm。构建 Agent 另需 **Go 1.26+**；目标 VPS 只需 Linux，Agent 为独立可执行程序。

以下命令在项目根目录执行：

```bash
npm ci
npm run admin -- --username admin
PUBLIC_URL=http://127.0.0.1:5173 npm run dev
```

首次初始化时交互式隐藏输入管理员密码，长度为 12～256 个字符，没有默认密码。已有管理员时跳过初始化，在后台“设置”中修改密码。

浏览器访问 `http://127.0.0.1:5173`，中心默认监听 `127.0.0.1:8766`，Vite 代理 API 和 SSE。如果 Vite 使用了其他端口，需将 `PUBLIC_URL` 改为实际访问地址后重新启动。

默认中心库为 `./data/control.db`。使用自定义 `DB_PATH` 时，管理员初始化和启动服务必须指向同一份中心库，勿指向旧版 `traffic.db`。

构建后由中心同时提供前端和 API：

```bash
npm run build
PUBLIC_URL=http://127.0.0.1:8766 npm start
```

## Docker Compose 部署中心

完整的首次部署、域名与证书配置、Nginx 模板、镜像拉取、升级备份及排障步骤见 [部署指南](docs/deployment.md)。以下为快速启动命令。

需要 Docker Engine 和 Compose 插件。默认使用镜像 `ghcr.io/x-dr/linux-traffic-monitor:latest`，仅需下载仓库的 `compose.yaml` 到固定部署目录，无需 Dockerfile 或源码。在该目录执行以下命令，拉取镜像、初始化管理员并启动中心：

```bash
docker compose pull control
sudo install -d -m 700 -o 1000 -g 1000 ./data
docker compose run --rm --pull never control node apps/api/dist/apps/api/src/admin.js --username admin
docker compose up -d --no-build control
docker compose logs --tail=50 control
curl --fail http://127.0.0.1:8766/health
```

管理员初始化仅首次执行。默认绑定宿主机 `127.0.0.1:8766`，中心将 Compose 文件所在目录的 `./data` 挂载到容器 `/data`，数据库保存在 `./data/control.db`。容器以非 root 用户（UID/GID `1000:1000`）和只读根文件系统运行，首次启动前用上方命令准备可写目录。已有 `control-data` 命名卷的部署须先按 [迁移步骤](docs/deployment.md#从旧命名卷迁移到项目-data-目录) 转移数据。中心本身不采集宿主机指标，需要在每台被监控 VPS 上安装 Agent。

远程初次访问可通过 SSH 转发：

```bash
ssh -L 8766:127.0.0.1:8766 root@你的服务器IP
```

然后在本地浏览器访问 `http://127.0.0.1:8766`。远程 Agent 接入需使用可达的 HTTPS 中心地址。

### HTTPS 反向代理

在 Compose 文件所在目录的 `.env` 中设置浏览器实际访问的 HTTPS 地址：

```dotenv
PUBLIC_URL=https://monitor.example.com
SECURE_COOKIES=true
```

Compose 会读取 `.env`；修改后执行 `docker compose up -d --no-build control` 使配置生效。按照 [Nginx 与 HTTPS 部署步骤](docs/deployment.md#4-配置-nginx-与-https)，使用 acme.sh 申请并自动续期证书，依次使用 [HTTP 证书验证模板](deploy/nginx-http.conf) 和 [正式 HTTPS 模板](deploy/nginx.conf)。正式配置包含 SSE 缓冲处理及 Agent 上报大小限制。

`PUBLIC_URL` 的协议、域名和端口必须与浏览器访问来源一致，否则登录或写操作会返回来源校验错误。

### 升级与备份

备份中心数据后，执行 `docker compose pull control` 和 `docker compose up -d --no-build control`，再检查日志和 `/health`。升级不需要重新初始化管理员。自行修改源码的构建步骤见 [部署指南](docs/deployment.md#可选从源码构建)。

升级至磁盘历史版本时，应先升级中心，再更新 Agent 至 1.1.0。两端数据库会增量升级至 v2，保留原有网卡流量、节点、配置与登录数据；中心继续接受旧 Agent 上报。磁盘读写历史从新 Agent 开始采集后产生，安装前的数据无法追溯。详细步骤见 [升级磁盘历史功能](docs/operations.md#升级磁盘历史功能)。

运行中的 SQLite 应使用备份 API 生成一致性备份，或停止对应服务后完整复制 `./data` 目录；Agent 数据也应单独备份。迁移前的 `control-data` 旧卷应保留用于回退，勿使用会删除卷的 `docker compose down -v`。

## 接入 Go Agent

### 下载发布版本

GitHub 仓库的 **Releases** 页面提供以下附件，无需在 VPS 上安装 Go：

- `traffic-agent-linux-amd64`：Intel / AMD 64 位 Linux 二进制文件。
- `traffic-agent-linux-arm64`：ARM 64 位 Linux 二进制文件。
- `SHA256SUMS`：上述二进制文件的 SHA-256 校验文件。

按架构下载程序和 `SHA256SUMS`，在同一目录执行（arm64 替换文件名）：

```bash
sha256sum --check --ignore-missing SHA256SUMS
chmod +x traffic-agent-linux-amd64
./traffic-agent-linux-amd64 version
```

Debian / Ubuntu 等系统另行下载 [systemd 服务文件](deploy/trafficmon-agent.service)，然后继续执行下方“创建节点与安装”；**Alpine Linux 使用 [OpenRC 服务文件](deploy/trafficmon-agent.openrc)，按 [Alpine 安装步骤](docs/operations.md#alpine-linuxopenrc) 操作**。发布程序以 `CGO_ENABLED=0` 构建，Alpine 可使用相同架构的二进制，无需安装 Go 或 glibc。二进制文件不包含节点凭据，`agent.json` 仍从后台创建节点时下载。

### 构建程序

在安装 Go 1.26+ 的构建机上，从项目根目录执行。API 测试中的恢复演练与 TLS 用例还需要 Python 3 和 OpenSSL；二者不参与中心生产运行：

```bash
cd agent
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -o bin/traffic-agent-linux-amd64 ./cmd/traffic-agent
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -buildvcs=false -trimpath -o bin/traffic-agent-linux-arm64 ./cmd/traffic-agent
sha256sum bin/traffic-agent-linux-*
cd ..
```

按 VPS 的 CPU 架构选择程序；`-buildvcs=false` 支持不含完整 Git 元数据的源码包。

### 创建节点与安装

登录后台，打开“接入 VPS”创建节点并下载 `agent.json`。每个节点有独立凭据，**仅在创建时展示一次**，中心只保存凭据摘要。配置中的 `server_url` 来自当前页面地址，传至 VPS 前需确认它是该 VPS 可达的 HTTPS 地址。HTTP 仅允许 `localhost`、`127.0.0.1` 和 `::1` 本机调试。

以下命令适用于 systemd 系统；Alpine Linux 请使用 [OpenRC 安装步骤](docs/operations.md#alpine-linuxopenrc)。将程序、下载的配置和 [systemd 服务文件](deploy/trafficmon-agent.service) 安全传到 VPS。同名系统用户已存在时跳过第一条；arm64 VPS 将程序文件名改为 `traffic-agent-linux-arm64`：

```bash
sudo useradd --system --home-dir /var/lib/trafficmon-agent --shell /usr/sbin/nologin trafficagent
sudo install -m 755 traffic-agent-linux-amd64 /usr/local/bin/traffic-agent
sudo install -d -o trafficagent -g trafficagent -m 700 /etc/trafficmon
sudo install -o trafficagent -g trafficagent -m 600 agent.json /etc/trafficmon/agent.json
sudo install -d -o trafficagent -g trafficagent -m 700 /var/lib/trafficmon-agent

# 实际采集并上报一次，成功后再启用常驻服务
sudo -u trafficagent /usr/local/bin/traffic-agent run --config /etc/trafficmon/agent.json --once
sudo install -m 644 trafficmon-agent.service /etc/systemd/system/trafficmon-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now trafficmon-agent
sudo journalctl -u trafficmon-agent --no-pager -n 30
```

配置文件权限须为 `0600`；配置目录须允许服务用户写入，以便原子保存中心下发的配置。默认状态目录为 `/var/lib/trafficmon-agent`，同一数据目录只能运行一个 Agent。不要在常驻服务运行时对同一目录再执行 `--once`。

接入后在节点详情核对主机名、资源、流量和配置应用状态。停用或归档会暂停中心接收，Agent 仍保留本地数据，恢复后继续补传。旧版迁移请先按下方迁移步骤准备目标目录，再安装服务。

## 配置

### 中心环境变量

| 变量 | 直接运行默认值 | 作用 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 中心监听地址；Compose 容器内为 `0.0.0.0` |
| `PORT` | `8766` | 中心 HTTP 端口 |
| `DB_PATH` | `./data/control.db` | 中心 SQLite 路径；Compose 为 `/data/control.db` |
| `PUBLIC_URL` | 未设置时按请求来源校验 | 浏览器访问地址；Compose 默认为 `http://127.0.0.1:8766` |
| `SECURE_COOKIES` | 按 `PUBLIC_URL` 是否为 HTTPS 推断 | `true` 时 Cookie 仅经 HTTPS 发送；Compose 默认 `false`，公网 HTTPS 部署需显式设为 `true` |
| `WEB_ROOT` | `./apps/web/dist` | 构建后的前端目录；镜像内已配置绝对路径 |
| `API_URL` | `http://127.0.0.1:8766` | 仅用于 Vite 开发服务器的 API 代理目标 |

直接执行 npm 命令时需通过 shell 设置或导出环境变量，服务不会自动加载根目录 `.env`。相对路径以项目根目录启动为前提。

### 节点监控配置

在节点详情的设置页调整网卡、每月起始日、时间和时区；无需手动编辑已接入 Agent 的配置。默认值如下：

```json
{
  "interfaces": "auto",
  "month_start_day": 1,
  "month_start_time": "00:00",
  "timezone": "Asia/Shanghai"
}
```

`auto` 优先选择默认 IPv4 路由网卡，找不到时选择可用网卡；也可指定 1～16 个网卡，例如 `["ens3", "eth1"]`。

## 流量统计规则

- 默认采用 `Asia/Shanghai` 时区，每月 **1 日 00:00** 切换统计周期。
- 支持自定义每月 **1～31 日** 与 `HH:MM`（24 小时制），按日历月份滚动，不是每隔 30 天。
- 例如每月 **15 日 08:00**：`2026-10-15 08:00`（含）～`2026-11-15 08:00`（不含），然后下一周期以此类推。
- 如果设置每月 31 日，2 月自动使用 28/29 日，4 月使用 30 日；下个月重新使用对应日期。
- 月流量由 SQLite 记录的 UTC **分钟级增量流量**计算。更改月开始日、时间和时区，会使用已有历史数据重新划分周期。
- 各节点可使用不同周期；总览显示各节点自身周期之和，仅汇总启用且未归档的节点。
- **总流量**是监控服务首次运行后采集到的上传+下载，系统启动之前或安装之前的历史流量不可追溯。
- 读取 Linux `/sys/class/net/<iface>/statistics/rx_bytes`（下载）与 `tx_bytes`（上传）。总计和月计均分别保存 RX / TX。
- 所有已监控网卡的累计记录均保留。改变选择网卡不会隐藏或删除以前的流量数据；**如果同时监控物理网卡和 VPN/网桥等叠加接口，可能重复计数**。
- 正常服务重启后读取持久化原始计数器基线，继续累计；系统重启或驱动计数器重置后也处理归零情况。
- 服务停止期间，如果网卡计数器仍能累计，恢复时尽力补记到恢复采样时刻；**停机跨越月界时，无法准确分摊停机期间的各月流量**。如需精确统计，应保持服务长期运行；每秒采样也存在边界处约一采样间隔的误差。
- Linux 内核通常将流量统计为接口收发的字节；与服务商账单的 L2 计费口径可能存在不同。

## 磁盘读写统计规则

- 统计 VPS 可见的块设备读写量，每约 5 秒读取计数器，使用真实采样间隔计算读写速度，按分钟保存字节增量和有效观测时长。
- 只纳入没有下层 slave 的整盘设备，排除分区、loop、ram、zram、光驱，以及会与底层磁盘重复的 LVM/RAID 叠加设备。磁盘 I/O 与文件系统容量按不同维度展示。
- 首次采样、系统重启、计数器下降、设备身份变化、不可读后恢复，或采样间断超过 15 秒时重新建立基线，避免出现虚假的读写尖峰。长时间停止采集期间的磁盘读写不补记。
- 跨分钟的采样区间按时间比例分摊字节，整数分配保留总量；小时/天曲线按每块磁盘的实际观测时长计算平均速度，再合并设备。区间累计量直接汇总已采集的整数增量。
- 缺失记录显示为空缺，已采集但没有读写显示为零。磁盘记录在 Agent 和中心均保留 30 天，支持断网补传和重复上报去重。

## 从旧版迁移

迁移默认只读预览，不创建目标目录，也不改写旧库：

```bash
traffic-agent migrate --legacy-db /旧目录/traffic.db --legacy-settings /旧目录/settings.json --target /新目录/trafficmon-agent
```

正式迁移前停止旧采集服务，确认旧库不再被写入，再执行：

```bash
traffic-agent migrate --legacy-db /旧目录/traffic.db --legacy-settings /旧目录/settings.json --target /新目录/trafficmon-agent --apply --legacy-stopped
```

目标目录必须不存在，且不能是旧库目录。迁移保留原文件，在新目录生成数据库、一致性备份、旧设置副本和不含凭据的 `agent.json` 模板。迁移到 `/var/lib/trafficmon-agent` 时，应先迁移，再执行安装步骤中的状态目录创建和权限设置。

把后台生成的中心地址和 token 填入迁移模板，保留迁移的 `settings`，将 `data_dir` 指向新目录，`applied_config_version` 保持 `0`，然后按上述步骤安装配置和服务。首次接入会导入旧配置；若中心配置已修改为版本大于 1，则以中心配置为准。

历史按批补传，需等待同步后核对累计下载/上传、本周期及上一周期。如需回退，应在迁移前另行保存旧版本程序和部署配置；回退时停止新 Agent，使用已保存的旧版本和原数据目录恢复服务。Agent 运行后产生的数据不会自动回写旧库。完整说明见 [运行与迁移指南](docs/operations.md#从旧版数据迁移)。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 无需登录的健康检查 |
| `GET` | `/api/v1/auth/setup-status` | 查询管理员是否已初始化 |
| `POST` | `/api/v1/auth/login` | 管理员登录 |
| `GET` | `/api/v1/auth/session` | 获取当前会话及 CSRF token |
| `POST` | `/api/v1/auth/logout`、`/api/v1/auth/password` | 退出登录、修改密码 |
| `GET` | `/api/v1/overview` | 总览统计 |
| `GET` / `POST` | `/api/v1/nodes` | 查询节点、创建节点并返回一次性展示的凭据 |
| `GET` / `PATCH` | `/api/v1/nodes/:id` | 节点详情、资料与状态管理 |
| `PUT` | `/api/v1/nodes/:id/config` | 下发监控配置 |
| `GET` | `/api/v1/nodes/:id/history?minutes=60` | 历史数据，范围 5～43200 分钟；可选 `interface`、`device` 和 `granularity=auto\|hour\|day`，返回设备选项与区间累计量 |
| `GET` | `/api/v1/events` | SSE 状态快照，连接后立即发送，随后每 5 秒更新 |
| `POST` | `/api/v1/agent/report` | Agent 上报，使用该节点的 Bearer token |

浏览器 API 除初始化状态和登录外均需会话 Cookie，写操作同时校验来源与 `X-CSRF-Token`。Agent token 仅用于上报。SSE 自动重连后重新获取快照；会话过期或撤销会关闭连接。

字节累计在 SQLite 中以 64 位整数保存，JSON 使用十进制字符串；速率单位为字节/秒，时间戳使用 UTC 秒。协议与样例见 [共享类型](packages/contracts/src/index.ts)、[上报 Schema](packages/contracts/report.schema.json) 和 [协议样例](packages/contracts/fixtures/report.json)。

## 开发检查

### GitHub Actions 构建与发布

工作流见 [.github/workflows/build.yml](.github/workflows/build.yml)，使用仓库内置 `GITHUB_TOKEN`，无需另配镜像仓库密码或 PAT。

工作流仅支持手动触发；推送分支、推送标签以及创建或更新 PR 均不会自动运行。手动运行时会构建 amd64 / arm64 中心镜像并推送到 GHCR，创建对应版本的 Release 并上传两个 Agent 二进制文件和 `SHA256SUMS`；同时保存 Actions artifact 14 天。

手动发布：进入 **Actions → Build images and agent → Run workflow**，选择要构建的分支或标签，在 `version` 中填写 `1.2.0` 或 `v1.2.0` 后运行。也支持 `1.2.0-rc.1` 等预发布版本；版本格式会在构建前校验，不支持 `+build` 构建元数据。

例如填写 `1.2.0`，会发布镜像 `:v1.2.0`、`:1.2.0`、`:latest`，创建 Release `v1.2.0`，并将 Agent 的 `version` 输出及上报版本设置为 `1.2.0`。无需预先创建 Git 标签，Release 发布时会把新标签指向本次构建的确切提交。已有同名标签必须指向本次构建提交，否则会提前终止，避免将另一份源码的二进制上传到旧版本；复用已有版本时应选择对应标签运行。本地构建未注入版本时保留源码中的默认 Agent 版本。

镜像名称中的 owner 和 repo 自动转为小写，镜像支持 `linux/amd64` 和 `linux/arm64`。`1.2.0-rc.1` 等预发布版本会创建预发布 Release，并且不更新 `latest`；选择 `main` 分支手动运行时还会生成 `:main` 镜像标签，每次运行也会生成 `sha-<短提交号>` 标签，正式部署可固定使用版本标签。

发布前会运行中心类型检查、测试和构建，以及 Agent 的 `go vet`、竞态测试和双架构静态编译。中心 amd64 镜像还会使用临时内存数据目录验证非 root、只读根文件系统下的实际启动、SQLite、静态页面、登录和 SSE；arm64 镜像完成构建，不代表已做设备运行验证。任一检查失败时不发布 Release。重新运行相同标签的工作流会更新该 Release 的同名附件。

首次发布后检查仓库的 **Packages** 页面：GHCR 包默认可能是私有的；如需匿名拉取，需将包的可见性设为 Public。若仓库或组织限制了 Actions 的包写入权限，需要在对应设置中允许该工作流发布包。

### 本地检查

从项目根目录执行：

```bash
npm run typecheck
npm test
npm run build
(cd agent && go test -race ./...)
```

浏览器验收前需完成前端构建、Linux amd64 Agent 构建，并安装 Chrome/Chromium。默认浏览器为 `/usr/bin/google-chrome`，可通过 `CHROME_PATH` 指定：

```bash
npm run test:e2e
# 使用其他已安装的浏览器时：
CHROME_PATH=/usr/bin/chromium npm run test:e2e
```

验收服务使用临时数据库、测试账号、独立端口及两个本机 Agent 进程。可运行 `LOAD_SECONDS=60 node --import tsx scripts/load-test.ts` 检查 50 个模拟 Agent 每 5 秒上报；该检查使用本地临时库，不代表生产容量或实际 VPS 部署结果。已有检查结果、截图及未验证事项见 [验证记录](docs/verification.md)。
