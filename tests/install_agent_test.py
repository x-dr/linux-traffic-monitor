import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('installer', Path(__file__).parents[1] / 'scripts' / 'install-agent.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
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
