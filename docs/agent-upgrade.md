# 更新已有 Go Agent

适用于已经接入中心的 Linux VPS。更新方式是：**先更新中心，下载并校验新程序，停止 Agent，完整备份，替换二进制，再启动并确认持续上报**。逐台更新，先用一台 VPS 验证。

中心镜像升级只会更新中心提供的下载文件，已有 VPS 上的 Agent 不会自动替换。`install-agent.py` 用于新安装，会拒绝覆盖已有配置、数据、程序或服务；`--resume` 也只用于恢复同一次安装尝试。更新已有节点无需注册令牌、重新创建节点或下载新的节点配置。

## 1. 确认路径与当前版本

本文使用仓库安装方式的默认路径：

| 内容 | 默认位置 |
| --- | --- |
| Agent 程序 | `/usr/local/bin/traffic-agent` |
| 节点配置与凭据 | `/etc/trafficmon/agent.json` |
| 本地状态目录 | `/var/lib/trafficmon-agent` |
| 本地 SQLite | 状态目录下的 `traffic.db`，以及可能存在的 `traffic.db-wal`、`traffic.db-shm` |
| systemd 服务 | `trafficmon-agent.service` |
| Alpine OpenRC 服务 | `/etc/init.d/trafficmon-agent` |

先在本机核对服务实际使用的配置文件和配置中的 `data_dir`；不要把含 token 的配置贴到聊天、工单或日志。自定义路径须修改下面变量，并确认服务使用相同路径。符号链接、挂载的数据目录和其他进程管理方式应按实际部署安排备份与恢复。

以下命令在目标 VPS 的 **root shell** 中按顺序执行。Debian / Ubuntu 可先执行 `sudo -i`；Alpine 直接使用 root，准备 `curl`、CA 证书及 `coreutils`（`apk add --no-cache curl ca-certificates coreutils`）。后续步骤沿用同一个 shell 中的变量。

```sh
set -eu
umask 077
binary_path=/usr/local/bin/traffic-agent
config_file=/etc/trafficmon/agent.json
data_dir=/var/lib/trafficmon-agent

test -x "$binary_path"
test -f "$config_file"
test -d "$data_dir"
test -f "$data_dir/traffic.db"
"$binary_path" version
uname -m
```

记录旧版本，并在中心核对该节点当前在线、累计流量和历史正常。当前源码默认 Agent 版本为 `1.3.0`，发布工作流可以注入其他版本；选择目标构建时以实际发布版本和校验值为准，相同版本字符串不保证程序内容相同。

先按 [中心升级指南](deployment.md#6-备份升级与恢复) 备份并更新中心，确认中心健康、原节点能继续上报，再执行以下 Agent 更新。中心已经是匹配版本时，只需核对健康与接收情况。Agent 启动时可能升级本地数据库；当前源码支持并迁移至 Agent 数据库 v4，中心数据库与 Agent 数据库各自独立。

## 2. 下载并校验目标程序

先完成下载和验证，减少服务停止时间。默认从自己的中心下载，替换为实际最终 HTTPS 地址：

```sh
center_url=https://monitor.example.com
download_base="$center_url/downloads/agent"
```

需要固定到某个已发布版本时，将上面的 `download_base` 改为该版本的 Release 附件路径，例如以下占位地址，`vX.Y.Z` 须替换成实际标签：

```sh
download_base=https://github.com/x-dr/linux-traffic-monitor/releases/download/vX.Y.Z
```

两种来源选择一种，再执行下面命令。程序与 `SHA256SUMS` 必须来自同一构建；从中心下载时，期间应避免再次升级中心。

```sh
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf '%s\n' '仅支持 Linux amd64 / arm64'; exit 1 ;;
esac
asset="traffic-agent-linux-$arch"
work_dir=$(mktemp -d /tmp/trafficmon-agent-update.XXXXXXXX)
cd "$work_dir"

curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
  "$download_base/$asset" -o "$asset"
curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
  "$download_base/SHA256SUMS" -o SHA256SUMS

# 仅校验本机架构，且要求清单中恰好有一条对应记录
awk -v file="$asset" '
  $2 == file || $2 == "*" file { print; found++ }
  END { if (found != 1) exit 1 }
' SHA256SUMS > SHA256SUMS.selected
sha256sum --check SHA256SUMS.selected
chmod 755 "$asset"
./"$asset" version
```

确认校验显示 `OK`，版本符合预期后再继续。这里的 `version` 不读取节点配置，也不会采集或上报。若临时目录所在文件系统禁止执行，改用允许执行的私有工作目录。

SHA256 用于检查文件完整性，程序和清单来自同一站点时仍需信任该 HTTPS 来源。校验不匹配就停止更新并重新获取同一构建的文件；保留正在运行的旧 Agent。中心返回 503 表示分发文件未准备好，404 时检查下载地址和中心版本，也可从对应 Release 获取程序。源码构建方法见 [README](../README.md#构建程序)。

## 3. 停止服务并完整备份

按实际系统选择一条停止命令：

```sh
# Debian / Ubuntu 等 systemd 系统
systemctl stop trafficmon-agent
```

```sh
# Alpine Linux / OpenRC
rc-service trafficmon-agent stop
```

确认服务已经停止，同一数据目录也没有手动启动的 Agent 进程，再备份。**先停止，再复制完整目录**，保留 SQLite 主文件、WAL、同步游标、累计值、采集源和基线；只复制运行中的 `traffic.db` 无法保证一致性。

```sh
install -d -m 700 /var/backups/trafficmon-agent
backup_dir=$(mktemp -d /var/backups/trafficmon-agent/update-XXXXXXXX)
cp -a "$binary_path" "$backup_dir/traffic-agent"
cp -a "$config_file" "$backup_dir/agent.json"
cp -a "$data_dir" "$backup_dir/data"
printf '升级前备份目录：%s\n' "$backup_dir"
```

记录打印的备份目录。备份内含节点凭据，应仅供 root 访问并按主机现有备份策略保存。若备份失败，先处理空间、权限或路径问题，确认完整备份成功后再替换程序；本流程出错会停止执行，不会自动恢复服务。

## 4. 替换二进制并启动

沿用原配置、原数据目录、原节点凭据和服务用户。通过同目录临时文件替换程序：

```sh
new_binary=$(mktemp "${binary_path}.new.XXXXXXXX")
install -o root -g root -m 755 "$work_dir/$asset" "$new_binary"
mv -f "$new_binary" "$binary_path"
"$binary_path" version
```

然后按系统选择启动命令：

```sh
systemctl start trafficmon-agent
systemctl show trafficmon-agent \
  -p ActiveState -p SubState -p MainPID -p NRestarts
journalctl -u trafficmon-agent --since '-5 minutes' --no-pager
```

```sh
rc-service trafficmon-agent start
rc-service trafficmon-agent status
tail -n 30 /var/log/trafficmon-agent/agent.log
```

此次只替换程序，服务定义沿用已有内容，无需执行 `daemon-reload`。首次启动会按需迁移本地库。常驻服务运行时，避免另行对同一目录执行 `run --once`；该命令会采集、写库并上报，不是只读检查。

通过批量安装脚本生成的 OpenRC 服务可能没有配置日志文件，此时按该主机实际日志配置检查；上面的日志路径适用于仓库提供的 [OpenRC 服务文件](../deploy/trafficmon-agent.openrc)。

## 5. 验证持续上报

启动后观察至少 60 秒，再重复上面的服务状态与日志检查，并在中心核对：

- 节点详情显示目标 Agent 版本，最近接收时间持续前进。
- CPU、内存、网络等指标持续更新，累计流量及原历史符合升级前记录。
- 已启用的探测、诊断或工作负载继续产生数据，配置状态最终显示已应用。
- 离线积压逐步减少，日志没有持续认证错误、HTTP 409 或数据库错误。

systemd 应持续为 `ActiveState=active`、`SubState=running`，观察期间 `NRestarts` 不再增长。单次显示运行中不能证明上报成功；成功上报也不一定产生日志，需结合中心接收时间和指标检查。上报间隔可配置为 1、3、5、10、15 秒，默认 5 秒；中心 SSE 默认每 5 秒推送。

一台 VPS 验证正常后，再按相同步骤更新下一台。保留升级前备份，直到确认版本稳定且符合既有备份保留策略。

## 6. 更新失败与回退

先检查日志和路径：

| 现象 | 处理方向 |
| --- | --- |
| `Exec format error` | 确认 `uname -m` 与下载架构对应 |
| systemd `217/USER` | 使用 `getent passwd trafficagent`、`getent group trafficagent` 核对服务账号和组 |
| 无法保存配置或写库 | 核对配置文件、配置目录和状态目录的所有者及权限；默认配置文件为 `0600`，目录为 `0700`，归 `trafficagent:trafficagent` 所有 |
| 数据目录被占用 | 停止同一目录的额外 Agent 进程，检查是否手动运行了 `--once` |
| HTTP 401 / 403 | 核对实际中心地址、原节点凭据和节点是否停用或归档 |
| HTTP 409 | 按 [上报冲突排查](operations.md#systemddebian--ubuntu-等) 核对采集源、配置版本和本地状态 |
| 数据库版本不可用 | 核对程序与库版本；使用与备份配套的程序、配置和数据恢复 |

HTTP 409 也可能发生在新 Agent 上；先按实际冲突原因处理。保留原始数据目录和 `source_id`，不要通过删库、改采集源或重新注册已有节点来尝试消除错误。

**回退要同时考虑旧程序、配置和数据库。** 如果新 Agent 已升级本地库，旧程序可能无法打开。新 Agent 已成功上报后，中心可能保存了更高的累计值、revision 或配置确认水位；此时直接恢复升级前 Agent 库可能触发 409 或历史缺口，应先保留当前完整状态，核对中心水位和版本，优先修复当前版本。恢复后的一次服务启动不代表同步一致。

下面仅适用于：新 Agent 尚未成功向中心上报、中心节点配置仍与备份一致，且使用本文默认的普通目录。仅在满足条件并确认需要回退时执行：

1. 使用第 3 节对应系统的命令停止 Agent，确认没有其他进程写入该目录。
2. 指定此前记录的完整备份，保留失败现场，再恢复配套文件：

```sh
# 替换为第 3 节打印的真实目录；重开 shell 时也需重设第 1 节路径变量
backup_dir=/var/backups/trafficmon-agent/update-实际目录名
test -f "$backup_dir/traffic-agent"
test -f "$backup_dir/agent.json"
test -f "$backup_dir/data/traffic.db"

# 保留当前状态，避免把不同版本的数据库和 WAL 混合覆盖
rollback_hold=$(mktemp -d "${data_dir}.before-rollback.XXXXXXXX")
cp -a "$config_file" "$rollback_hold/agent.json"
cp -a "$binary_path" "$rollback_hold/traffic-agent"
mv "$data_dir" "$rollback_hold/data"
cp -a "$backup_dir/data" "$data_dir"
cp -a "$backup_dir/agent.json" "$config_file"
new_binary=$(mktemp "${binary_path}.new.XXXXXXXX")
install -o root -g root -m 755 "$backup_dir/traffic-agent" "$new_binary"
mv -f "$new_binary" "$binary_path"
"$binary_path" version
printf '回退前状态保存在：%s\n' "$rollback_hold"
```

3. 使用第 4 节对应系统的命令启动服务，按第 5 节验证持续上报、累计和历史。

当前状态已保存在 `rollback_hold` 所指目录。恢复升级前备份不会包含升级后采集的数据，中心也不会自动回退；如发现 409，停止重复尝试并核对两端状态。中心回退、同步恢复与各阶段库版本的限制另见 [M1 指南](monitoring-m1-operations.md)、[网络探测指南](monitoring-m2a-operations.md) 和 [系统诊断及运行管理指南](monitoring-m2b-m3-operations.md#备份恢复与监控自身)。

本文为操作说明；命令需在目标 VPS 执行并验证，文档更新本身不代表 Agent 已更新或已完成生产验收。
