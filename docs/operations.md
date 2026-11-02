# 多 VPS 后台运行与迁移

设计见 [升级方案](multi-vps-upgrade-plan.md)。中心使用 TypeScript，采集端使用 Go Agent，二者必须使用各自的数据路径。旧版历史数据可通过 Agent 的迁移命令导入。

## 本地开发

要求 Node.js 24、Go 1.26+。以下操作在仓库根目录执行：

```bash
npm ci
npm run admin -- --username admin
npm run dev
```

管理员命令交互式隐藏输入密码（12～256 字符），不设置默认密码。中心默认 `127.0.0.1:8766`，前端开发服务器输出实际访问地址（通常 `127.0.0.1:5173`），通过 Vite 代理访问 API 和 SSE。使用开发服务器时将 `PUBLIC_URL` 设为前端实际地址，例如：

```bash
PUBLIC_URL=http://127.0.0.1:5173 npm run dev
```

默认中心库 `./data/control.db`；可以用 `DB_PATH=/绝对路径/control.db` 为管理员命令和服务同时指定独立库。不要指向现有 `traffic.db`。生产构建与运行：

```bash
npm run build
npm start
```

## Docker 中心

首次部署、完整 Nginx 配置、acme.sh 证书申请与续期、GHCR 镜像使用及备份步骤见 [Docker 与 Nginx 部署指南](deployment.md)。

以下命令会拉取 `ghcr.io/x-dr/linux-traffic-monitor:latest`、准备项目 `data` 目录、初始化管理员并启动中心服务。已有命名卷的部署先按 [迁移步骤](deployment.md#从旧命名卷迁移到项目-data-目录) 转移数据：

```bash
docker compose pull control
sudo install -d -m 700 -o 1000 -g 1000 ./data
docker compose run --rm --pull never control node apps/api/dist/apps/api/src/admin.js --username admin
docker compose up -d --no-build control
docker compose logs --tail=50 control
```

默认只映射本机 `127.0.0.1:8766`。正式公开访问前，在 `.env` 中设置实际 HTTPS 域名：

```dotenv
PUBLIC_URL=https://monitor.example.com
SECURE_COOKIES=true
```

反向代理使用 [正式 Nginx 模板](../deploy/nginx.conf)，保留 Host，设置 X-Forwarded-Proto，并关闭 SSE 缓冲；首次申请证书请按 [HTTPS 部署步骤](deployment.md#4-配置-nginx-与-https) 操作。

中心镜像使用非 root 用户（UID/GID `1000:1000`），Compose 文件同目录的 `./data` 挂载至容器 `/data`，数据库位于 `./data/control.db`。升级前应通过 SQLite 备份 API 或停服务后的完整复制保留整个数据目录。迁移前的旧命名卷也应保留，不运行会删除卷的 `docker compose down -v`。

## 构建与接入 Go Agent

在 `agent` 目录构建，无需在目标 VPS 安装 Go：

```bash
cd agent
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -o bin/traffic-agent-linux-amd64 ./cmd/traffic-agent
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -buildvcs=false -trimpath -o bin/traffic-agent-linux-arm64 ./cmd/traffic-agent
sha256sum bin/traffic-agent-linux-*
```

`-buildvcs=false` 同样支持没有完整 Git 元数据的源码包。交叉编译成功只说明可构建，不替代目标架构运行验证。

在后台“接入服务器”创建节点并下载配置；凭据仅展示一次，不保存到浏览器存储。确认 `server_url` 是实际 HTTPS 中心地址；本机开发仅允许 localhost/127.0.0.1/::1 使用 HTTP。

### systemd（Debian / Ubuntu 等）

将对应架构二进制、下载的 `agent.json` 和仓库 `deploy/trafficmon-agent.service` 安全传到 VPS，然后执行以下安装命令（会创建系统用户、安装文件并启用服务）：

```bash
sudo useradd --system --home-dir /var/lib/trafficmon-agent --shell /usr/sbin/nologin trafficagent
sudo install -m 755 traffic-agent-linux-amd64 /usr/local/bin/traffic-agent
sudo install -d -o trafficagent -g trafficagent -m 700 /etc/trafficmon
sudo install -o trafficagent -g trafficagent -m 600 agent.json /etc/trafficmon/agent.json
sudo install -d -o trafficagent -g trafficagent -m 700 /var/lib/trafficmon-agent
sudo -u trafficagent /usr/local/bin/traffic-agent run --config /etc/trafficmon/agent.json --once
sudo install -m 644 trafficmon-agent.service /etc/systemd/system/trafficmon-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now trafficmon-agent
sudo journalctl -u trafficmon-agent --no-pager -n 30
```

已有用户时跳过 useradd。arm64 VPS 使用 arm64 程序。Agent 需要对配置所在目录有写权限，以便原子保存中心下发的配置；配置与目录仅对服务用户可读写。systemd 示例仅开放该目录和状态目录写入。每个数据目录有进程锁，同一目录不能重复启动 Agent。

在线状态正常后，详情页应出现主机名、CPU、内存、负载和网络指标。默认未上报 15 秒标为陈旧，45 秒标为离线；历史数据保留。停用/归档会拒绝继续上报，恢复后自动补传。

需要永久移除时，在“节点设置 → 节点状态管理”点击“删除节点”并确认。中心端节点、关联历史、告警、通知和资产会永久清除，旧节点令牌立即失效；停用和归档仍可用于保留历史的场景。删除不会停止或卸载服务器上的 Agent，需在对应服务器自行处理。共享配置、报表和数据范围见 [删除节点说明](node-deletion.md)。

在节点详情的“节点设置 → Agent 上报设置”中选择 **1、3、5、10、15 秒**，点击“保存上报间隔”。默认 5 秒。配置随下一次上报下发，Agent 成功写入本地配置后切换调度，并在后续上报确认，页面由“待应用”变为“已应用”，无需重启。网络采样仍为 1 秒，资源与磁盘采样仍为 5 秒；浏览器 SSE 仍每 5 秒推送，因此 1 秒上报不代表页面每秒刷新所有指标。

中心与 Agent 均需更新到支持 `reporting:1` 能力的构建。旧 Agent 显示“需升级 Agent”，仍按 5 秒上报；可先保存配置，升级后自动领取。中心只给声明该能力的 Agent 下发 `report_interval_seconds`，原监控配置和探测/诊断/工作负载保持独立。更新诊断配置时不会清掉已保存的上报间隔。

如果 Agent 已更新但仍显示“需升级 Agent”，先检查日志是否持续出现 **HTTP 409**。这表示上报冲突，不能仅凭界面提示认定二进制过旧。Agent 只有成功上报能力后，中心才能确认它支持自定义上报间隔。

- 中心使用 `data/control.db`；Agent 使用配置 `data_dir` 下的 `traffic.db`，默认 `/var/lib/trafficmon-agent/traffic.db`。保留中心库不等于保留了 Agent 的本地状态。
- 使用配置中的节点凭据定位中心节点，再只读比较两端 `source_id`。同一凭据配上不同的采集源会在能力保存前返回 409；常见原因是误用另一台 VPS 的配置，或重新创建了 Agent 数据目录。
- 若原来的完整数据目录仍在，核对它的采集源和本地状态后，停止 Agent、完整备份配置及相关数据目录，再切回正确目录。不要将未经核实的旧 Agent 数据库备份直接上线。
- 若是另一台 VPS 或原数据目录已经丢失，创建独立节点，保留旧节点及其历史。让当前采集源使用新节点配置，保留当前本地库；不要直接篡改 `source_id`、清空中心绑定或删除中心数据。
- 其他 409 还可能来自扩展配置版本、指标配置版本或探测结果冲突，需按具体原因处理。本次日志修复后，Agent 会显示已知的固定冲突原因；中心日志会记录 `Agent 上报冲突`，不记录凭据或上报正文。未知响应仍只显示状态码。

恢复后应持续观察接收时间前进、409 停止，并确认上报设置接口的 `supported` 为 `true`，随后配置版本得到 Agent 确认。单次 `active (running)` 不能证明上报恢复。

可配置 Agent 的陈旧阈值为 `max(15, 间隔 × 3)` 秒，离线阈值为 `max(45, 间隔 × 9)` 秒。10 秒档为 30 / 90 秒，15 秒档为 45 / 135 秒；配置待确认时按 15 秒间隔容错，旧 Agent 保持 15 / 45 秒。资源告警、探测页面和流量预测的新鲜度同步适配；告警规则中自定义的离线/陈旧触发阈值仍由管理员控制，选长间隔时应检查这些阈值。

### Alpine Linux（OpenRC）

Alpine VPS 使用 OpenRC 管理 Agent。发布二进制通过 `CGO_ENABLED=0` 构建，可直接在 Alpine 上运行，无需 Go、glibc 或兼容层；程序已内嵌时区数据。以下操作以 **root** 执行，不依赖 `sudo`。

先在后台“接入 VPS”创建节点并下载 `agent.json`，确认 `server_url` 是 VPS 可达的最终 HTTPS 地址。将以下文件安全传到 VPS 的同一目录：

- 对应架构的发布程序：`uname -m` 为 `x86_64` 时选 `traffic-agent-linux-amd64`，为 `aarch64` 时选 `traffic-agent-linux-arm64`。
- 同一版本的 `SHA256SUMS`。
- 后台下载的 `agent.json`，每台 VPS 使用各自的节点配置。
- [trafficmon-agent.openrc](../deploy/trafficmon-agent.openrc) 服务文件。

进入该目录后执行；示例使用 amd64，ARM64 将安装命令中的程序文件名替换为 `traffic-agent-linux-arm64`。已有同名组或用户时跳过对应的创建命令。这是首次安装步骤；已有 Agent 的更新方法见下文。

```sh
apk add --no-cache openrc ca-certificates coreutils
sha256sum --check --ignore-missing SHA256SUMS

addgroup -S trafficagent
adduser -S -D -H -h /var/lib/trafficmon-agent -s /sbin/nologin -G trafficagent trafficagent
install -m 755 traffic-agent-linux-amd64 /usr/local/bin/traffic-agent
install -d -o trafficagent -g trafficagent -m 700 /etc/trafficmon /var/lib/trafficmon-agent
install -o trafficagent -g trafficagent -m 600 agent.json /etc/trafficmon/agent.json

# 先验证一次上报，成功后再启动常驻服务
su -s /bin/sh -c '/usr/local/bin/traffic-agent run --config /etc/trafficmon/agent.json --once' trafficagent
install -m 755 trafficmon-agent.openrc /etc/init.d/trafficmon-agent
rc-update add trafficmon-agent default
rc-service trafficmon-agent start
rc-service trafficmon-agent status
tail -n 30 /var/log/trafficmon-agent/agent.log
```

`coreutils` 提供上述 `install` 和支持 `--ignore-missing` 的 `sha256sum`；HTTPS 上报需要系统 CA 证书。不要把 `useradd`、`systemctl` 或 `journalctl` 命令用于 Alpine。

服务以 `trafficagent` 用户运行，异常退出后由 `supervise-daemon` 重启。服务启动时准备权限为 `0700` 的配置、状态和日志目录，日志文件为 `0600`。配置目录必须允许该用户写入，以保存中心下发的配置。默认状态目录为 `/var/lib/trafficmon-agent`；若修改 `agent.json` 的 `data_dir`，同时调整服务文件中的 `directory` 和 `start_pre` 的状态目录。

常用运维命令：

```sh
rc-service trafficmon-agent stop
rc-service trafficmon-agent start
rc-service trafficmon-agent restart
tail -f /var/log/trafficmon-agent/agent.log
```

更新 Agent 时，先备份配置和状态目录，再停止服务、替换二进制并重新启动，保留原 `agent.json` 和数据目录；无需重新创建节点。不要在常驻服务运行时对同一数据目录执行 `--once`。日志保存在 `/var/log/trafficmon-agent/agent.log`，长期运行时应纳入主机现有日志轮转。

启动后在后台确认节点在线、主机名和资源指标，并检查监控配置是否已应用。容器内的 OpenRC 检查不能替代实际 VPS 的开机启动验证。服务编写方式参考 [OpenRC 官方 supervisor 指南](https://github.com/OpenRC/openrc/blob/master/supervise-daemon-guide.md)。

## 更新已有 Agent

逐台更新时，先升级中心，再下载并校验匹配架构的 Agent，停止服务后完整备份原程序、配置和数据目录，替换二进制并启动，最后在中心确认持续上报。沿用原节点凭据与本地库，无需重新创建节点；`install-agent.py` 仅用于新安装。

systemd / OpenRC 的完整命令、下载来源选择、验收和配套回退见 [Agent 更新指南](agent-upgrade.md)。恢复旧 Agent 库前须核对中心确认水位，避免已上报后直接恢复旧库产生冲突。

## 从旧版数据迁移

先执行只读预览；不会创建目标目录：

```bash
traffic-agent migrate --legacy-db /旧目录/traffic.db --legacy-settings /旧目录/settings.json --target /新目录/trafficmon-agent
```

正式迁移命令会创建新的目标目录。先停止旧采集服务，并确认不再写旧库：

```bash
traffic-agent migrate --legacy-db /旧目录/traffic.db --legacy-settings /旧目录/settings.json --target /新目录/trafficmon-agent --apply --legacy-stopped
```

目标必须不存在，且不能是旧库目录；迁移先生成 SQLite 一致性备份，在临时目录完成后整体落盘。目标包含新库、`legacy-backup.db`、`legacy-settings.json` 和不含凭据的 `agent.json` 模板。将后台生成的中心地址和节点 token 填入该模板，保留迁移的 `settings`，确保 `data_dir` 指向新目录；凭据不要放到命令参数、聊天或日志中。

若迁移至 `/var/lib/trafficmon-agent`，应在安装步骤创建状态目录之前完成迁移。之后调整新目录所有者，将完成的配置安装到 `/etc/trafficmon/agent.json`。配置 `applied_config_version` 保持 0，使首次接入导入原周期和网卡配置；中心已有修改（版本大于 1）时以中心配置为准。

核对旧预览与新后台的累计下载/上传、本周期和上一周期；历史按每批最多 256 条自动回填，较大历史库需等待同步完成。资源和流量分别同步，回填不会阻塞实时状态。失败重试不会重复累计。

如需回退，请在迁移前另行保存旧版本程序及其部署配置。回退时停止新 Agent，使用已保存的旧版本和原数据目录恢复服务。迁移不会覆盖原数据文件；Agent 运行后产生的数据不会自动倒灌回旧库。

## 检查命令

```bash
npm run typecheck
npm test
npm run build
XDG_CACHE_HOME=/tmp/traffic-antd antd lint apps/web/src --format json
cd agent
go test -race ./...
```

根目录 `npm run test:e2e` 使用临时数据库、测试账号和独立端口启动验收服务。需要先完成前端构建和 amd64 Agent 构建，本机需安装 Chromium/Chrome。`LOAD_SECONDS=60 node --import tsx scripts/load-test.ts` 验证 50 个模拟 Agent 每 5 秒上报，使用临时库并清理，不连接实际 VPS。

可用下列命令对已拉取的发布镜像运行隔离的启动检查，数据仅保存在容器内存中，退出后自动清理；自行构建时将镜像地址替换为本地镜像名：

```bash
docker run --rm -i --read-only --tmpfs /data:uid=1000,gid=1000,mode=0700 --tmpfs /tmp --network none ghcr.io/x-dr/linux-traffic-monitor:latest node --input-type=module < scripts/docker-smoke.mjs
```

## 升级磁盘历史功能

1. 按前文备份中心库和各 Agent 数据目录。此版本把两端数据库从 v1 增量升级至 v2，仅新增磁盘表、索引和同步游标，不改写既有网络历史。
2. 先更新并启动中心。中心继续接受 1.0.0 Agent 的原有上报；页面在旧 Agent 尚未提供磁盘指标时显示明确的空状态。
3. 按前文构建对应架构的 1.1.0 Agent，再逐台停止旧 Agent、替换可执行程序并启动。保留原 `agent.json` 和数据目录，无需重新创建节点、修改凭据或迁移网卡历史。不要对同一个数据目录同时运行两个采集进程。
4. 在节点详情确认 Agent 版本、磁盘列表、硬盘读写曲线和区间累计量。初次采集先建立基线，下一次有效采样后产生历史；没有可读取整盘统计的 VPS 会显示无指标提示。

新协议沿用 `protocol_version=1`，上报增加可选 `disk_io` 分钟数组、快照的可选 `disk_io` 与 `disk_io_supported`；中心确认增加可选 `ack.disk_io`。新 Agent 发出磁盘数据后要求匹配的磁盘 ACK，因此需要按上述顺序升级。两端 v2 数据目录不直接交给旧版程序使用；回退需使用与旧版程序匹配的升级前备份。

历史 API 示例为 `/api/v1/nodes/<节点ID>/history?minutes=10080&interface=ens3&device=vda&granularity=day`。网卡与磁盘筛选互相独立；`day` 以 UTC 自然日为桶边界，但查询区间维持所选分钟范围，不额外计入区间之外的数据。响应的 `network.total`、`disk_io.total` 是字符串字节累计，`points[].disk_io` 包含读取/写入字节及观测平均速度。无磁盘数据的累计量为 `null`；有观测但无读写的累计量为 `"0"`。

磁盘历史保留 30 天；网络历史仍长期保存。系统重启、设备计数器重置、不可读后恢复和超过 15 秒的采样间断会重新建立基线。短暂 Agent 重启可继续使用持久化基线；长期停采期间的磁盘 I/O 不补记。已有网络补记规则保持不变。

## 监控 M1 升级

告警中心、Webhook、维护静默、流量套餐、预测，以及中心回退后的 Agent 重新同步，见 [M1 使用与升级指南](monitoring-m1-operations.md)。中心数据库新增 v2→v3 迁移；Agent 数据库与 v1 上报协议不变。实际交付状态见 [升级进度](monitoring-upgrade-progress.md)。

## 网络探测阶段

M2-A 新增能力协商、独立探测配置、ICMP/TCP/HTTP 和证书历史。中心库升至 v4，Agent 1.2.0 库升至 v3。先升级中心，再试运行一台新 Agent；旧 Agent 继续采集原指标。任务、本地允许网段、统计口径及回退限制见 [网络探测指南](monitoring-m2a-operations.md)。本地验收不替代实际 VPS 常驻运行验证。

## M2-B / M3 增量功能

当前升级新增独立诊断/工作负载流，中心 v5、Agent v4；新采集默认关闭。开启、备份/回退、批量接入与报表口径见 [系统诊断及运行管理指南](monitoring-m2b-m3-operations.md)。不要将旧阶段记录中的库版本当作当前版本。
