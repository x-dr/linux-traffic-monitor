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

以下命令会拉取 `ghcr.io/x-dr/linux-traffic-monitor:latest`、初始化管理员、创建持久化卷并启动中心服务：

```bash
docker compose pull control
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

中心镜像使用非 root 用户，卷保存 SQLite 数据。不要运行 `docker compose down -v`，它会删除卷。升级前应通过 SQLite 备份 API 或停服务后的完整复制保留数据库。

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

在线状态正常后，详情页应出现主机名、CPU、内存、负载和网络指标。未上报 15 秒标为陈旧，45 秒标为离线；历史数据保留。停用/归档会拒绝继续上报，恢复后自动补传。

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
