# 中心分发 Agent

日期：2026-11-02。

## 分阶段实施

1. 镜像打包：构建 Linux amd64 / arm64 静态 Agent，随中心镜像保存二进制、SHA256SUMS 和安装脚本；发布版本继续由手动工作流输入。
2. 中心分发：提供固定文件白名单下载接口，流式返回文件，不要求浏览器登录；安装脚本默认从所选中心下载匹配架构的程序并校验 SHA256。接入页提供下载入口。
3. 验收与文档：检查双架构文件、版本及校验值、匿名 GET/HEAD、缺失与非法路径、安装保护、只读非 root 容器和原中心功能。仅执行本地验证，不发布、不部署。

## 分发约定

- 路径：`/downloads/agent/traffic-agent-linux-amd64`、`traffic-agent-linux-arm64`、`SHA256SUMS`、`install-agent.py`。
- 两种中心镜像架构均包含两种 Agent，不以中心 CPU 架构限制被监控节点。
- 只分发公开程序，不返回节点配置、令牌、数据库或目录列表；注册仍沿用现有短期凭据流程。
- 下载可在安装前匿名进行；HTTPS 和 SHA256 校验保留。清单与文件来自同一中心，校验用于检查传输完整性，不能替代对中心的信任；可显式传入已核对的 SHA256。
- 固定下载地址随中心镜像版本更新，响应要求重新验证缓存；旧安装升级仍先备份、停止服务，再替换程序，保留原配置与历史。
- 源码运行可用 `AGENT_DIST_ROOT` 指向已准备好的分发目录；缺少文件返回 503，不回落到网页。

## 进度

- [x] 检查现有 Dockerfile、手动发布工作流、安装脚本、接入页面与认证边界。
- [x] 镜像及发布版本打包。
- [x] 下载接口、安装默认值与页面入口。
- [x] 本地验证、操作文档与结果记录。

## 使用

1. 镜像发布并更新中心后，可在“接入 VPS”下载对应架构程序与 SHA256SUMS；下载命令见 [README](../README.md#从中心下载推荐)。已有节点更新见 [Agent 更新指南](agent-upgrade.md)，保留原配置和数据，无需重新注册。
2. 新节点批量接入在“运行管理”创建短期凭据，下载并检查安装脚本，复制带注册 ID 的命令预览，确认后以 root 添加 `--apply`；令牌在隐藏提示中输入。
3. 镜像内目录为 `/app/agent-dist`，不需要挂载数据卷；匿名下载不会读取中心数据库。源码模式使用 `AGENT_DIST_ROOT` 指定目录，包含两个二进制、SHA256SUMS 和 `install-agent.py`。

源码模式准备示例（在仓库根目录执行，先按 README 构建 `agent/bin` 下的两个二进制）：

```bash
mkdir -p artifacts/agent
cp agent/bin/traffic-agent-linux-amd64 agent/bin/traffic-agent-linux-arm64 artifacts/agent/
cp scripts/install-agent.py artifacts/agent/
(cd artifacts/agent && sha256sum traffic-agent-linux-* > SHA256SUMS)
```

Docker 本地构建可用 `docker build --build-arg AGENT_VERSION=1.3.0 -t linux-traffic-monitor:control .`；不填写 `AGENT_VERSION` 则使用源码默认版本。Go 构建工具链与工作流的 `agent/go.mod` 版本保持一致，以使相同源码、编译参数生成相同校验值。手动发布前 smoke 会将镜像内清单与独立 Release 构建清单逐字比较，并检查运行版本。

## 本地验收

- API：新增 2 项下载回归，覆盖公开 GET/HEAD、原始字节、清单、安装脚本、文件白名单、路径穿越、缺失文件和 SPA 回落；完整 **82 项通过**。首次沙箱运行有 4 项旧测试被临时端口/子进程限制阻止，放开相关环境限制后全部通过。
- Python：**12 项通过**（安装 6 项、重同步 6 项）。包括中心默认下载、自定义源强制指定校验值、清单重复/缺失/非法校验值、有界读取，以及默认安装在校验失败时不会注册或写文件。
- `npm run typecheck`、`npm run build`、actionlint、`git diff --check`：通过。
- 完整 Dockerfile 构建本地镜像 `linux-traffic-monitor:agent-distribution`，显式版本 `1.3.0`；在无网络、只读根目录、非 root、临时 `/data` 与 `/tmp` 条件下通过 smoke。核对双架构 ELF 类型与机器标识、SHA256、GET/HEAD、安装脚本内容、原生程序版本，以及原登录/CSRF/SSE/SQLite v6/监控管理流程。
- 不传 `AGENT_VERSION` 的完整构建也通过（`linux-traffic-monitor:agent-distribution-default`）；只读无网络容器内执行原生 Agent，确认源码默认版本 `1.3.0`。
- 同一 Go 1.26.0 工具链从独立只读源码路径按 Release 参数重新编译，两种程序的 SHA256 均与镜像内清单完全一致。
- Chrome：真实点击下载二进制与安装脚本、核对 SHA256/脚本内容、创建注册凭据后命令包含对应 ID；1440/390/320px 无横向溢出、无页面错误。只使用临时内存数据库。
- 截图：[接入桌面](../artifacts/agent-distribution-connect-1440.png)、[接入手机](../artifacts/agent-distribution-connect-390.png)、[批量接入桌面](../artifacts/agent-distribution-management-1440.png)、[批量接入手机](../artifacts/agent-distribution-management-390.png)。

没有提交、推送、发布或部署，也没有在目标 VPS 创建账号/安装服务。arm64 二进制已编译并检查 ELF，没有在 arm64 设备运行；本轮未重跑未修改的 Go 单元/竞态测试。目标中心需发布并更新镜像后才会提供这些新下载地址。
