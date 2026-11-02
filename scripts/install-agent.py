#!/usr/bin/env python3
"""校验并安装新的 Agent。默认预览；凭据只通过终端提示输入。"""
import argparse
import getpass
import hashlib
import json
import os
import pathlib
import platform
import pwd
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('不接受重定向，请使用最终下载地址')


class DownloadRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != 'https' or not target.hostname or target.username or target.password:
            raise ValueError('下载重定向必须保持 HTTPS')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def architecture(machine=None):
    machine = machine or platform.machine()
    if machine in ('x86_64', 'amd64'):
        return 'amd64'
    if machine in ('aarch64', 'arm64'):
        return 'arm64'
    raise ValueError('仅支持 Linux amd64/arm64')


def init_system():
    if pathlib.Path('/run/systemd/system').is_dir() and shutil.which('systemctl'):
        return 'systemd'
    if shutil.which('rc-service') and shutil.which('rc-update'):
        return 'openrc'
    raise ValueError('未发现 systemd/OpenRC；请按运维文档手动配置')


def https_url(value, local=False):
    url = urllib.parse.urlsplit(value)
    if (url.scheme != 'https' and not (local and url.scheme == 'http' and url.hostname in ('127.0.0.1', '::1'))) or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('需要不含凭据和查询参数的 HTTPS 地址')
    return value.rstrip('/')


def check_existing(config, data, binary):
    if any(pathlib.Path(p).exists() for p in (config, data, binary)):
        raise ValueError('已有配置、数据目录或二进制；请使用现有升级流程，本工具不会覆盖')


def verify_binary(body, expected):
    if len(expected) != 64 or not all(c in '0123456789abcdefABCDEF' for c in expected):
        raise ValueError('需要发布清单中的 SHA256')
    if hashlib.sha256(body).hexdigest() != expected.lower():
        raise ValueError('Agent SHA256 不匹配')
    if not body.startswith(b'\x7fELF'):
        raise ValueError('下载内容不是 ELF 程序')


def write_private(path, body):
    path = pathlib.Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(path, 'x', encoding='utf8') as file:
        os.chmod(path, 0o600)
        file.write(body)
        file.flush()
        os.fsync(file.fileno())


def write_service(path, unit, resume):
    target = pathlib.Path(path)
    if target.exists():
        if not resume or target.is_symlink() or target.read_text() != unit:
            raise ValueError('现有服务单元不属于此次安装，停止处理')
    else:
        write_private(target, unit)


def enroll(server, registration_id, request_id, name, secret):
    request = urllib.request.Request(server + '/api/v1/agent/register',
        data=json.dumps(dict(registration_id=registration_id, request_id=request_id, name=name)).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret}, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=15) as response:
        body = response.read(16385)
    if len(body) > 16384:
        raise ValueError('注册响应过大')
    data = json.loads(body)
    if len(data.get('token', '')) < 32:
        raise ValueError('注册响应无效')
    uuid.UUID(data['node_id'])
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True)
    parser.add_argument('--registration-id', required=True)
    parser.add_argument('--name', default=platform.node())
    parser.add_argument('--download-url', required=True, help='最终 HTTPS 下载 URL，{arch} 自动替换')
    parser.add_argument('--sha256', required=True, help='对应架构发布清单的 SHA256')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--resume', action='store_true', help='恢复本工具留下的同一安装尝试，不覆盖其他安装')
    args = parser.parse_args()
    if sys.platform != 'linux':
        raise ValueError('只支持 Linux')
    server = https_url(args.server)
    uuid.UUID(args.registration_id)
    arch, manager = architecture(), init_system()
    download = https_url(args.download_url.replace('{arch}', arch))
    config, data, binary = '/etc/trafficmon/agent.json', '/var/lib/trafficmon-agent', '/usr/local/bin/traffic-agent'
    attempt_path = pathlib.Path('/var/lib/trafficmon-installer/attempt.json')
    if not args.resume:
        if any(pathlib.Path(p).exists() for p in ('/etc/systemd/system/trafficmon-agent.service', '/etc/init.d/trafficmon-agent')):
            raise ValueError('已有 Agent 服务单元，请使用升级流程')
        check_existing(config, data, binary)
    elif not attempt_path.is_file():
        raise ValueError('没有可恢复的安装尝试')
    print(f'架构 {arch}；服务 {manager}；新安装；默认非 root 运行。')
    if not args.apply:
        print('预览完成。执行安装时添加 --apply，令牌会通过隐藏终端输入。')
        return
    if os.geteuid() != 0:
        raise ValueError('安装系统服务需要 root；Agent 本身使用 trafficagent 账号')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), DownloadRedirect())
    # Release assets may redirect to a CDN; only HTTPS redirects are accepted.
    with opener.open(download, timeout=60) as response:
        body = response.read(64 * 1024 * 1024 + 1)
    if len(body) > 64 * 1024 * 1024:
        raise ValueError('下载超过 64 MiB')
    verify_binary(body, args.sha256)
    # A stable attempt ID survives failed requests without persisting the registration secret.
    if attempt_path.exists():
        attempt = json.loads(attempt_path.read_text())
        if attempt['server'] != server or attempt['registration_id'] != args.registration_id or attempt.get('sha256') != args.sha256.lower():
            raise ValueError('存在其他注册尝试，请先人工核对')
    else:
        attempt = dict(server=server, registration_id=args.registration_id, request_id=str(uuid.uuid4()), sha256=args.sha256.lower())
        write_private(attempt_path, json.dumps(attempt))
    if pathlib.Path(config).exists():
        if not args.resume or pathlib.Path(config).is_symlink():
            raise ValueError('拒绝覆盖现有配置')
        saved = json.loads(pathlib.Path(config).read_text())
        if saved.get('server_url') != server or saved.get('data_dir') != data or len(saved.get('token', '')) < 32:
            raise ValueError('现有配置与此次安装不一致')
        registration = dict(token=saved['token'])
    else:
        secret = getpass.getpass('短期注册令牌（不回显）：')
        registration = enroll(server, args.registration_id, attempt['request_id'], args.name, secret)
        secret = None
    try:
        account = pwd.getpwnam('trafficagent')
    except KeyError:
        if shutil.which('useradd'):
            subprocess.run(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'trafficagent'], check=True)
        elif shutil.which('adduser'):
            subprocess.run(['adduser', '-S', '-D', '-H', '-s', '/sbin/nologin', 'trafficagent'], check=True)
        else:
            raise ValueError('缺少系统账号创建工具，请先创建 trafficagent')
        account = pwd.getpwnam('trafficagent')
    if account.pw_uid == 0:
        raise ValueError('trafficagent 账号不能使用 UID 0')
    if pathlib.Path(data).is_symlink():
        raise ValueError('数据目录不能是符号链接')
    pathlib.Path(data).mkdir(mode=0o700, exist_ok=args.resume)
    os.chown(data, account.pw_uid, account.pw_gid)
    if pathlib.Path(binary).exists():
        if not args.resume or pathlib.Path(binary).is_symlink():
            raise ValueError('拒绝覆盖现有二进制')
        verify_binary(pathlib.Path(binary).read_bytes(), args.sha256)
    else:
        fd = os.open(binary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755)
        with os.fdopen(fd, 'wb') as target:
            target.write(body)
            target.flush()
            os.fsync(target.fileno())
    settings = dict(interfaces='auto', month_start_day=1, month_start_time='00:00', timezone='Asia/Shanghai')
    if not pathlib.Path(config).exists():
        write_private(config, json.dumps(dict(server_url=server, token=registration['token'], data_dir=data, settings=settings, applied_config_version=0)))
    os.chown(config, account.pw_uid, account.pw_gid)
    os.chown(pathlib.Path(config).parent, account.pw_uid, account.pw_gid)
    # Agent atomically replaces config after applying independent configuration updates.
    if manager == 'systemd':
        unit = '[Unit]\nDescription=Traffic Monitor Agent\nAfter=network-online.target\n[Service]\nUser=trafficagent\nGroup=trafficagent\nExecStart=/usr/local/bin/traffic-agent run --config /etc/trafficmon/agent.json\nRestart=on-failure\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/etc/trafficmon /var/lib/trafficmon-agent\n[Install]\nWantedBy=multi-user.target\n'
        write_service('/etc/systemd/system/trafficmon-agent.service', unit, args.resume)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'enable', '--now', 'trafficmon-agent'], check=True)
    else:
        unit = '#!/sbin/openrc-run\nname="Traffic Monitor Agent"\ncommand="/usr/local/bin/traffic-agent"\ncommand_args="run --config /etc/trafficmon/agent.json"\ncommand_user="trafficagent:trafficagent"\nsupervisor="supervise-daemon"\ndepend() { need net; }\n'
        write_service('/etc/init.d/trafficmon-agent', unit, args.resume)
        os.chmod('/etc/init.d/trafficmon-agent', 0o755)
        subprocess.run(['rc-update', 'add', 'trafficmon-agent', 'default'], check=True)
        subprocess.run(['rc-service', 'trafficmon-agent', 'start'], check=True)
    print('已安装并请求启动服务。请在中心确认持续上报和同步状态。')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, urllib.error.URLError, subprocess.CalledProcessError):
        print('安装未完成。请检查网络、校验值、现有文件及服务状态；凭据未输出。', file=sys.stderr)
        sys.exit(1)
