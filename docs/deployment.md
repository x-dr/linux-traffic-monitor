# 部署指南：Docker Compose 与 Nginx

本文使用 **Docker Compose 运行中心、同一台宿主机上的 Nginx 提供 HTTPS、acme.sh 申请并续期证书、各 VPS 通过 systemd 运行 Go Agent**。示例系统为使用 systemd 的 Debian / Ubuntu，域名为 `monitor.example.com`；执行前请替换为自己的域名。

访问链路：浏览器与 Agent → `https://monitor.example.com:443` → Nginx → `127.0.0.1:8766` → 中心容器。中心同时提供前端、API 和 SSE，不需要单独部署前端文件。

## 1. 准备服务器与域名

- 将域名 A 记录解析到中心 VPS 的公网 IPv4。设置 AAAA 记录时，IPv6 也必须能访问该 VPS。
- 在云安全组和宿主机防火墙中允许 TCP `80`、`443`，保留自己的 SSH 管理端口。`80` 用于证书验证和 HTTPS 跳转。
- 安装 Docker Engine 与 Compose 插件，步骤见 Docker 官方 [Ubuntu 安装指南](https://docs.docker.com/engine/install/ubuntu/) 或 [Debian 安装指南](https://docs.docker.com/engine/install/debian/)。
- 将本仓库的 `compose.yaml` 保存到固定部署目录，后续命令均在该目录执行。默认拉取 `ghcr.io/x-dr/linux-traffic-monitor:latest`，无需 Dockerfile、项目源码或宿主机上的 Node.js / Go；从源码构建时才需要完整仓库。

检查 Docker，并安装代理与证书工具：

```bash
docker version
docker compose version
sudo apt-get update
sudo apt-get install -y nginx curl ca-certificates openssl cron
sudo systemctl enable --now nginx cron
```

以下 Docker 命令假定当前账户可以访问 Docker；否则在命令前添加 `sudo`。无需将 `8766` 开放到公网，Compose 已将该端口绑定到宿主机回环地址。

已有 Nginx 站点时，先检查是否有相同 `server_name` 或占用 `80/443` 的其他服务；保留其他站点配置。本文仅安装 `/etc/nginx/conf.d/trafficmon.conf`，修改已有同名文件前请先备份。

## 2. 配置中心地址

在 Compose 文件所在目录创建或编辑 `.env`，保留已有配置：

```bash
touch .env
chmod 600 .env
${EDITOR:-vi} .env
```

写入：

```dotenv
CONTROL_IMAGE=ghcr.io/x-dr/linux-traffic-monitor:latest
PUBLIC_URL=https://monitor.example.com
SECURE_COOKIES=true
```

`PUBLIC_URL` 必须与浏览器实际使用的协议、域名、端口一致，使用独立域名的根路径，不添加 `/monitor` 等路径前缀。若使用非标准 HTTPS 端口，地址也要包含该端口，并同步调整 Nginx 监听与跳转。

Compose 默认值与生产配置的关系如下：

| 配置 | 当前仓库配置 | 部署时的处理 |
| --- | --- | --- |
| 服务名 | `control` | 下文所有中心命令均使用此服务名 |
| `CONTROL_IMAGE` | `ghcr.io/x-dr/linux-traffic-monitor:latest` | Compose 使用的中心镜像，默认直接拉取 |
| 宿主机端口 | `127.0.0.1:8766` | 由同机 Nginx 访问，保持回环绑定 |
| 容器监听 | `0.0.0.0:8766` | 由 Compose 配置，无需修改 |
| 数据库 | 容器内 `/data/control.db` | 挂载至 Compose 文件同目录的 `./data/control.db` |
| `PUBLIC_URL` | `http://127.0.0.1:8766` | 在 `.env` 中改为实际 HTTPS 地址 |
| `SECURE_COOKIES` | `false` | 公网 HTTPS 部署显式设为 `true` |

部署目录的 `.env` 由 Compose 读取；直接运行 `npm start` 不会自动加载它。修改 `.env` 后使用 `docker compose up -d --no-build control` 重建容器配置，单纯 `restart` 不会更新环境变量。

## 3. 拉取镜像并启动中心

首次部署使用镜像 `ghcr.io/x-dr/linux-traffic-monitor:latest`，拉取后准备数据目录、初始化管理员并启动。已有命名卷的部署先按下方迁移步骤转移数据：

```bash
docker compose config --quiet
docker compose pull control
sudo install -d -m 700 -o 1000 -g 1000 ./data

# 仅首次部署执行：交互式隐藏输入密码，长度为 12～256 个字符
docker compose run --rm --pull never control node apps/api/dist/apps/api/src/admin.js --username admin

docker compose up -d --no-build control
docker compose ps
docker compose logs --tail=50 control
curl --fail --show-error http://127.0.0.1:8766/health
```

健康检查应返回 `{"ok":true}`；容器内置的健康检查每 30 秒执行一次，刚启动时可能显示 `starting`。管理员初始化与中心使用同一个 `./data` 目录，没有默认密码；已有管理员时跳过初始化，通过后台“设置”修改密码。不要将密码写入命令参数、`.env` 或脚本。

中心容器以非 root 用户（UID/GID `1000:1000`）运行，根文件系统只读，项目的 `./data` 绑定挂载至容器 `/data`，`/tmp` 为临时内存文件系统。绑定挂载使用宿主机目录权限，镜像中 `/data` 的所有者不会自动应用到宿主机目录；首次启动前执行上方 `install` 命令，以免 Docker 自动创建 root 所有的目录导致 SQLite 无法写入。已有数据时还需检查数据库及 WAL / SHM 文件均对该用户可写，不要将整个数据目录改为 `777`。

`./data` 相对于 Compose 文件所在目录解析。在 `/root/linux-traffic-monitor` 部署时，数据库位于宿主机 `/root/linux-traffic-monitor/data/control.db`。后续保持同一部署目录；更换目录时须同时迁移 `data`，否则会连接到空库。

公开镜像可以匿名拉取；私有镜像需先通过 `docker login ghcr.io` 按提示认证。后续启动使用 `--no-build`，升级先执行 `docker compose pull control`，确保使用仓库中的发布镜像。

### 从旧命名卷迁移到项目 data 目录

挂载方式切换不会自动复制旧卷的数据。已有管理员、节点或历史时，按以下顺序迁移：

1. 保留旧 Compose 文件及其项目名，仍使用旧挂载配置执行 `docker compose stop control`，再按 [备份步骤](#停中心后备份整个数据目录) 导出完整 `/data` 并校验归档。这些备份命令同样适用于旧命名卷；迁移时跳过示例中的 `docker compose start control`，保持中心停止直到第 4 步，避免恢复期间旧库继续写入。
2. 在 Compose 文件同目录准备空的 `data` 目录；已有同名目录时先确认内容，保留原数据并使用另一个空目录恢复，避免覆盖。
3. 将备份中的全部文件恢复到目标目录，包括仍存在的 `control.db-wal`、`control.db-shm`，再将该目录及恢复文件的所有者设为 `1000:1000`，目录权限设为 `700`。
4. 将 `control` 的挂载改为 `./data:/data`（恢复到其他目录时使用对应路径），删除不再使用的顶层 `volumes: control-data:` 配置，再执行 `docker compose up -d --no-build control`。
5. 核对原管理员、节点和历史。保留旧命名卷和备份以便回退，不重新初始化管理员。

### 可选：从源码构建

需要运行自行修改的源码时，准备完整仓库（包含 Dockerfile），并将仓库根目录 `.env` 中的 `CONTROL_IMAGE` 改为本地镜像名：

```dotenv
CONTROL_IMAGE=linux-traffic-monitor:control
```

然后构建并启动；首次部署仍需在启动前按前文准备 `./data` 并初始化管理员：

```bash
docker build -t linux-traffic-monitor:control .
# 首次部署时，在这里初始化管理员
docker compose up -d --no-build control
```

构建标签必须与 `.env` 中的 `CONTROL_IMAGE` 一致。默认 Compose 不含 `build` 配置，使用本地镜像时先显式执行 `docker build`，再沿用 Compose 的端口、数据卷和运行约束。镜像发布标签说明见 [README](../README.md#github-actions-构建与发布)。

## 4. 配置 Nginx 与 HTTPS

仓库提供两份配置，均放入 Nginx 的 `http {}` 上下文，例如 `/etc/nginx/conf.d/trafficmon.conf`。它们是同一个站点的两个阶段，**依次替换，不同时启用**：

- [nginx-http.conf](../deploy/nginx-http.conf)：仅用于首次申请证书，提供 ACME 验证路径，其他请求返回 404。
- [nginx.conf](../deploy/nginx.conf)：正式 HTTPS 站点，包含 HTTP 跳转、证书和中心反向代理。

### 4.1 先启用 HTTP 验证站点

下面的 `sed` 会生成安装副本，保留仓库模板。替换命令中的 `monitor.your-domain.com` 为自己的域名：

```bash
sudo install -d -m 755 /var/www/acme/.well-known/acme-challenge
sed 's/monitor.example.com/monitor.your-domain.com/g' deploy/nginx-http.conf > /tmp/trafficmon-http.conf
sudo install -m 644 /tmp/trafficmon-http.conf /etc/nginx/conf.d/trafficmon.conf
sudo nginx -t && sudo systemctl reload nginx
```

先确认 `nginx -t` 成功，再申请证书。不要提前安装引用尚不存在证书的 HTTPS 配置，否则 Nginx 配置检查会失败。

### 4.2 使用 acme.sh 申请并安装证书

此处及后续命令中的 `monitor.example.com` 均替换为实际域名，`admin@example.com` 替换为自己的邮箱。以下将 acme.sh 安装到 root 的 `/root/.acme.sh`，后续使用同一账户管理证书：

```bash
curl -fsSL https://get.acme.sh -o /tmp/trafficmon-acme-install.sh
sudo -H sh /tmp/trafficmon-acme-install.sh email=admin@example.com
sudo -H /root/.acme.sh/acme.sh --register-account --server letsencrypt -m admin@example.com

sudo -H /root/.acme.sh/acme.sh --issue \
  --server letsencrypt \
  -d monitor.example.com \
  --webroot /var/www/acme \
  --keylength ec-256
```

这里显式选择 Let's Encrypt CA，webroot 验证通过公网 `80` 端口完成，不需要停止 Nginx。域名解析、IPv4/IPv6 或安全组不正确时需先修复再重试。安装方式见 [acme.sh 官方安装说明](https://github.com/acmesh-official/acme.sh/wiki/How-to-install)，CA 参数见 [官方 Server 文档](https://github.com/acmesh-official/acme.sh/wiki/Server)。

签发成功后，将证书安装到 Nginx 使用的固定路径，并保存续期后的重载命令：

```bash
sudo install -d -m 700 /etc/nginx/ssl/monitor.example.com
sudo -H /root/.acme.sh/acme.sh --install-cert -d monitor.example.com --ecc \
  --key-file /etc/nginx/ssl/monitor.example.com/privkey.pem \
  --fullchain-file /etc/nginx/ssl/monitor.example.com/fullchain.pem \
  --reloadcmd '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx'
```

Nginx 使用上述安装路径，不直接引用 `/root/.acme.sh` 内部文件。`--install-cert` 会记录目标路径和 `--reloadcmd`，续期后自动更新证书并重载 Nginx，见 [acme.sh 官方证书安装说明](https://github.com/acmesh-official/acme.sh)。首次安装时仍重载 HTTP 站点，下一步再启用 HTTPS。

已有可信证书时可以跳过申请，在下一步配置中填写实际证书链与私钥的绝对路径。Agent 会验证证书链与主机名；自签名证书需要在 Agent 所在系统配置相应信任根。

### 4.3 切换到 HTTPS 配置

```bash
sed 's/monitor.example.com/monitor.your-domain.com/g' deploy/nginx.conf > /tmp/trafficmon-https.conf
sudo install -m 644 /tmp/trafficmon-https.conf /etc/nginx/conf.d/trafficmon.conf
sudo nginx -t && sudo systemctl reload nginx

curl --fail --show-error https://monitor.example.com/health
curl --head http://monitor.example.com/
```

HTTPS 健康检查应返回 `{"ok":true}`，HTTP 首页应返回 `301` 并跳转到相同域名的 HTTPS。示例同时监听 IPv4/IPv6；服务器禁用 IPv6 时删除两份配置中的 `listen [::]` 行。

正式配置的关键行为：

- `/` 整体代理到 `http://127.0.0.1:8766`，保留请求路径；页面路由、静态资源、API 和 SSE 都由中心处理。
- 保留 Host、Cookie、Origin、Authorization 和 CSRF 请求头；不另加登录拦截或修改 Agent 上报路径。
- 显式使用 HTTP/1.1，清空上游 `Connection`，关闭代理缓冲、缓存和 gzip，使 `/api/v1/events` 的 SSE 数据及时到达。`proxy_read_timeout 60s` 是两次读取之间的空闲超时，不是连接总寿命；中心每 5 秒推送一次。参见 [Nginx 代理模块文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。
- `client_max_body_size 2m` 与中心的 2 MiB 限制一致，避免默认代理限制拦截 Agent 补传。

此配置要求 **Nginx 运行在宿主机上**。若使用容器化 Nginx，应让它与中心处于同一个 Docker 网络，并将上游改为 `http://control:8766`；Nginx 容器中的 `127.0.0.1` 指向它自身。本文不需要修改默认 Compose 端口映射。

如域名前还有 CDN 或其他代理，同样要关闭 API 缓存、保留 SSE 流并确保 Agent 上报路径可直接访问。当前中心只信任回环来源的代理头，Docker 桥接转发后可能按代理地址执行登录限流；不要仅凭 `X-Forwarded-For` 判断已实现真实客户端 IP 限流。

### 4.4 检查自动续期与 Nginx 重载

acme.sh 安装时会为 root 创建每日检查的 cron 任务；需要续期时自动签发，随后执行上一节保存的证书安装与重载操作。检查 cron、已管理证书，并手动执行一次到期检查：

```bash
sudo systemctl is-active cron
sudo crontab -l | grep -F 'acme.sh'
sudo -H /root/.acme.sh/acme.sh --list
sudo -H /root/.acme.sh/acme.sh --cron --home /root/.acme.sh
```

证书未到续期时间时跳过属于正常结果；`--cron` 是实际到期检查，不是模拟签发。保留 HTTP 的 ACME 验证路径和公网 `80` 端口。若需要重新验证安装路径及重载命令，重复第 4.2 节的 `--install-cert` 即可，不必强制重新签发。root 的 acme.sh 账户和续期配置位于 `/root/.acme.sh`，应按凭据文件限制访问并备份。

## 5. 登录与接入 VPS

1. 浏览器打开 `https://monitor.example.com`，使用第 3 节初始化的管理员登录。
2. 在“接入 VPS”创建节点并下载 `agent.json`；凭据仅在创建时展示一次。
3. 在该 VPS 安装对应架构的 Go Agent 和 [systemd 服务](../deploy/trafficmon-agent.service)，完整下载、校验、安装命令见 [README 的 Agent 接入步骤](../README.md#接入-go-agent)。
4. 在启动常驻服务前以 `trafficagent` 用户执行一次上报，再启用 systemd 服务；后台核对节点在线状态、主机名和资源指标。

中心镜像同时包含 Linux amd64 / arm64 Agent，可直接从 `/downloads/agent/traffic-agent-linux-amd64` 或 `/downloads/agent/traffic-agent-linux-arm64` 下载；校验文件为 `/downloads/agent/SHA256SUMS`。以上地址通过现有 Nginx 根路径代理提供，不需要新增端口或卷。完整下载命令见 [从中心下载](../README.md#从中心下载推荐)。批量注册可使用中心提供的 `/downloads/agent/install-agent.py`，默认自动选择架构并校验；注册凭据在“运行管理”创建。

每台被监控 VPS（包括需要监控的中心宿主机）都要单独安装 Agent。仅运行中心容器不会采集宿主机指标。Agent 主动通过 HTTPS 上报，无需开放入站端口。

Alpine Linux VPS 请使用 [OpenRC Agent 安装步骤](operations.md#alpine-linuxopenrc) 和 [OpenRC 服务文件](../deploy/trafficmon-agent.openrc)，其中包含 Alpine 的依赖、系统用户、单次上报及开机启动命令。

`agent.json` 中的 `server_url` 来自下载配置时浏览器的来源，应为最终可达的 HTTPS 地址。Agent 不跟随重定向；不要填写 HTTP 跳转地址。配置权限须为 `0600`，服务用户须能写入配置目录及 `/var/lib/trafficmon-agent`，以便保存下发配置和断网数据。不要在常驻服务运行时对同一个数据目录重复执行 `--once`。

### 部署验收

- `docker compose ps` 中中心持续运行，健康状态为 `healthy`；本机和公网 HTTPS 的 `/health` 都返回成功。
- 浏览器登录后可刷新并保留会话，修改节点设置正常，无“请求来源不匹配”或 CSRF 错误。
- 浏览器开发者工具 Network 中 `/api/v1/events` 为 `200`，响应类型为 `text/event-stream`，每约 5 秒收到 `snapshot` 事件；长连接持续 pending 为正常现象。
- Agent 日志无连接、证书、权限或上报拒绝错误，节点保持在线，监控配置显示已应用。

`/health` 成功仅证明中心可响应，不代表登录、SSE、证书续期或真实 VPS 上报已经验证。

## 6. 备份、升级与恢复

### 停中心后备份整个数据目录

以下命令只在执行时停止中心，不停止各 VPS Agent；Agent 会保留本地数据等待恢复后补传。备份可能包含会话和节点配置，应限制访问。

```bash
umask 077
backup_dir="$HOME/trafficmon-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
docker compose stop control
docker compose run --rm --no-deps --pull never -T control tar -C /data -czf - . > "$backup_dir/control-data.tar.gz"
tar -tzf "$backup_dir/control-data.tar.gz" >/dev/null
docker compose start control
cp .env compose.yaml "$backup_dir/"
docker compose images control > "$backup_dir/images.txt"
```

确认归档命令和 `tar` 校验均成功后再升级；若备份失败，先恢复中心运行并处理失败原因。此方式在中心停止后复制整个 `/data`，包括仍存在的 SQLite WAL / SHM 文件；不要在运行时只复制 `control.db`。如不能停服务，使用 SQLite 的一致性备份 API。

中心的 `./data` 目录与 Agent 的 `/var/lib/trafficmon-agent`、`/etc/trafficmon/agent.json` 分别备份。保留迁移前的旧命名卷，不执行 `docker compose down -v`。示例把备份保存在仓库之外，避免提交或进入镜像构建上下文；还应将备份另存到服务器外。

### 升级

先完成备份，保持项目目录和 `./data` 挂载路径不变。默认镜像使用 `latest`，升级时重新拉取并重建容器：

```bash
docker compose pull control
docker compose up -d --no-build control
docker compose ps
docker compose logs --tail=50 control
curl --fail --show-error https://monitor.example.com/health
```

`latest` 会随正式发布变化，回退时使用备份记录中的旧镜像 ID 或提前保存的镜像。源码构建部署则先更新源码，保持 `.env` 中的本地镜像名，执行 `docker build -t linux-traffic-monitor:control .`（标签与 `CONTROL_IMAGE` 一致）后再按上方命令启动并检查，跳过拉取步骤。Docker 构建阶段会交叉编译两种 Agent，不要求宿主机安装 Go；可添加 `--build-arg AGENT_VERSION=1.3.0` 注入版本，省略时使用源码默认版本。手动发布工作流自动将输入版本同时用于镜像内及 Release 的 Agent，并检查 SHA256 一致。

升级不重新初始化管理员。需要更新 Agent 时先更新中心，再逐台更新 Agent；磁盘历史版本的兼容与回退要求见 [运行指南](operations.md#升级磁盘历史功能)。

### 恢复与回退

使用与备份匹配的程序或镜像版本，先停止中心。为备份准备一个**新的空目录**，解压完整归档，将目录及恢复文件的所有者设为 `1000:1000`、目录权限设为 `700`，再将 Compose 中 `./data:/data` 左侧的宿主机路径指向恢复目录并启动。保留原数据目录，避免解压覆盖现有数据；不要仅换回旧程序却继续使用已升级的新库。

启动后按前文重新验证管理员、节点、历史与 Agent 补传。若恢复点早于 Agent 最近一次同步，已确认数据不会保证自动重传；需要同时评估并恢复相应 Agent 备份。

## 7. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 初始化时提示 `Dockerfile: no such file or directory` | 镜像部署的 Compose 不应包含 `build`；删除旧配置中 `control` 下的整个 `build` 项，再执行 `docker compose pull control` 后初始化。`--pull never` 仅禁止拉取镜像，不禁止构建 |
| Nginx 返回 502 | 检查 `docker compose ps`、中心日志及宿主机 `curl http://127.0.0.1:8766/health`；确认 Nginx 与中心在同一宿主机，或使用了正确的 Docker 网络上游 |
| `nginx -t` 提示证书不存在 | 先使用 HTTP 模板申请证书，再执行 acme.sh `--install-cert`，核对 `/etc/nginx/ssl/<实际域名>/` 下的安装文件后切换 HTTPS |
| 证书申请失败或公网超时 | 核对 A / AAAA、80 端口、安全组、防火墙及是否有 CDN 拦截 ACME 路径 |
| 登录 / 写操作提示来源不匹配 | 核对浏览器实际地址与 `.env` 的 `PUBLIC_URL`，修改后 `docker compose up -d --no-build control`；不要去掉 Origin / CSRF 校验 |
| 登录后仍提示未登录 | 检查浏览器 Cookie 与 HTTPS 访问地址；生产配置 `SECURE_COOKIES=true` 时不能通过普通 HTTP 使用会话 |
| 提示管理员未初始化或原节点不见了 | 检查 `./data` 的实际宿主机路径和 `/data/control.db` 挂载，确认连接的是原数据目录；旧命名卷的数据须先迁移 |
| SQLite 提示无法打开数据库或只读 | 检查 `./data` 是否已创建，以及目录、数据库和 WAL / SHM 文件是否对容器用户 `1000:1000` 可写；不要用 root 运行服务或将目录改为 `777` |
| 实时数据延迟、SSE 断开 | 检查 Nginx / CDN 的缓冲、压缩、缓存与空闲超时；登录后在 Network 查看 SSE 事件，会话到期后重新登录 |
| Agent 上报 HTTP 413 | 确认所有代理请求体限制不小于 `2m`；中心自身仍限制为 2 MiB |
| Agent 上报 401 / 403 或节点离线 | 确认使用该节点的配置、节点未停用/归档、服务器时钟正常；检查 `sudo journalctl -u trafficmon-agent --no-pager -n 50` |
| Agent 提示配置权限或保存失败 | 配置为 `0600` 且属于服务用户，配置目录可写；使用提供的 systemd 服务及匹配的数据目录 |

中心诊断命令为 `docker compose logs --tail=100 control`，Nginx 默认错误日志通常是 `/var/log/nginx/error.log`。分享诊断结果前去掉密码、Bearer token、Cookie 和 CSRF token；不要直接展示 `agent.json`。

## M1 通知与配额配置

本地 M1 升级使用中心数据库 v3，Agent 保持 v2。发布部署前按 [M1 升级及通知密钥指南](monitoring-m1-operations.md) 备份并验证副本；默认 Compose 无须通知密钥。需要 Webhook 时使用可选的 `deploy/compose.notifications.yaml` 单独挂载密钥，部署镜像必须包含本次源码。实际完成情况见 [进度文档](monitoring-upgrade-progress.md)。

## 网络探测版本

M2-A 的中心与 Agent 需分别备份和升级：中心数据库 v4；Agent 1.2.0 数据库 v3；基础上报协议仍为 v1。升级不自动启用探测，保留原凭据与流量；优先升级中心，再在一台 Agent 上验证。完整使用、私网允许网段与恢复步骤见 [网络探测指南](monitoring-m2a-operations.md)。此处为部署说明，本次未发布镜像或更新实际服务。
