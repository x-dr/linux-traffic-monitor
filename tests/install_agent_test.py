import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, call, patch
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('installer', Path(__file__).parents[1] / 'scripts' / 'install-agent.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_center_download_defaults_and_explicit_checksum(self):
        server = 'https://monitor.example.com'
        self.assertEqual(installer.download_source(server, 'arm64'), server + '/downloads/agent/traffic-agent-linux-arm64')
        url = 'https://example.com/releases/traffic-agent-linux-{arch}'
        checksum = 'a' * 64
        self.assertEqual(installer.download_source(server, 'amd64', url, checksum), url.replace('{arch}', 'amd64'))
        with self.assertRaises(ValueError):
            installer.download_source(server, 'amd64', url)
        with self.assertRaises(ValueError):
            installer.download_source(server, 'amd64', checksum='invalid')

    def test_manifest_requires_unique_valid_checksum_for_selected_architecture(self):
        amd64, arm64 = 'a' * 64, 'B' * 64
        manifest = f'{amd64}  traffic-agent-linux-amd64\n{arm64} *traffic-agent-linux-arm64\n'.encode()
        self.assertEqual(installer.checksum_for(manifest, 'amd64'), amd64)
        self.assertEqual(installer.checksum_for(manifest, 'arm64'), arm64.lower())
        for invalid in (b'', b'<html>error</html>', manifest + manifest, b'bad  traffic-agent-linux-amd64\n',
                        f'{amd64}  ../traffic-agent-linux-amd64\n'.encode()):
            with self.assertRaises(ValueError):
                installer.checksum_for(invalid, 'amd64')

    def test_download_is_bounded_and_does_not_send_credentials(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'too long'
        with patch.object(installer.urllib.request, 'build_opener') as build_opener:
            build_opener.return_value.open.return_value = response
            with self.assertRaises(ValueError):
                installer.download_bytes('https://monitor.example.com/downloads/agent/SHA256SUMS', 4)
            response.__enter__.return_value.read.assert_called_once_with(5)
            build_opener.return_value.open.assert_called_once_with('https://monitor.example.com/downloads/agent/SHA256SUMS', timeout=60)

    def test_default_install_verifies_center_binary_before_registration_or_writes(self):
        binary = b'\x7fELFtest-center-binary'
        checksum = hashlib.sha256(binary).hexdigest()
        manifest = f'{checksum}  traffic-agent-linux-amd64\n'.encode()
        argv = ['install-agent.py', '--server', 'https://monitor.example.com', '--registration-id',
                '11111111-1111-4111-8111-111111111111', '--apply']
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), patch.object(sys, 'argv', argv), \
                 patch.object(installer, 'init_system', return_value='systemd'), \
                 patch.object(installer, 'architecture', return_value='amd64'), \
                 patch.object(installer.os, 'geteuid', return_value=0), \
                 patch.object(Path, 'exists', return_value=False), \
                 patch.object(installer, 'download_bytes', side_effect=[manifest, b'corrupt' if corrupt else binary]) as download, \
                 patch.object(installer, 'write_private') as write, \
                 patch.object(installer.getpass, 'getpass', return_value='test-only-registration-input'), \
                 patch.object(installer, 'enroll', side_effect=ValueError('test stop before system installation')) as enroll, \
                 patch('builtins.print'):
                with self.assertRaisesRegex(ValueError, 'SHA256 不匹配' if corrupt else 'test stop'):
                    installer.main()
                self.assertEqual(download.call_args_list, [
                    call('https://monitor.example.com/downloads/agent/SHA256SUMS', 16384),
                    call('https://monitor.example.com/downloads/agent/traffic-agent-linux-amd64', 64 * 1024 * 1024),
                ])
                if corrupt:
                    enroll.assert_not_called()
                    write.assert_not_called()
                else:
                    enroll.assert_called_once()
                    self.assertEqual(json.loads(write.call_args.args[1])['sha256'], checksum)

    def test_architecture_and_url_policy(self):
        self.assertEqual(installer.architecture('aarch64'), 'arm64')
        self.assertEqual(installer.architecture('x86_64'), 'amd64')
        with self.assertRaises(ValueError):
            installer.architecture('i386')
        for url in ('http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret'):
            with self.assertRaises(ValueError):
                installer.https_url(url)

    def test_checksum_and_no_overwrite_or_service_replacement(self):
        body = b'\x7fELFtest-only'
        installer.verify_binary(body, hashlib.sha256(body).hexdigest())
        with self.assertRaises(ValueError):
            installer.verify_binary(body, '0' * 64)
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'config'
            installer.write_private(target, 'private')
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                installer.check_existing(target, Path(root) / 'data', Path(root) / 'binary')
            service = Path(root) / 'service'
            installer.write_service(service, 'fixed unit', False)
            installer.write_service(service, 'fixed unit', True)
            with self.assertRaises(ValueError):
                installer.write_service(service, 'other unit', True)


if __name__ == '__main__':
    unittest.main()
