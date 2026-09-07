"""Local filesystem tests. No SSH connection, privileged host or external endpoint."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'frontend-release-remote.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class StaticAccess(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lk-static-access-')
        self.root = Path(self.temp.name)
        self.store = self.root / 'lk-frontend-releases'
        self.store.mkdir()
        self.previous = self.store / ('1' * 40 + '-' + 'a' * 16)
        self.previous.mkdir()
        self.fill(self.previous, '1' * 40)
        (self.store / 'current').symlink_to(self.previous.name)
        self.public = self.root / 'lk-frontend-current'
        self.public.symlink_to('lk-frontend-releases/current')
        (self.root / 'lk').mkdir()
        (self.root / 'lk/index.html').write_text('legacy')
        self.old = m.run({'op': 'inspect'}, self.root)
        self.token = 'b' * 32
        self.name = '2' * 40 + '-' + 'b' * 16
        self.candidate = Path(m.run({'op': 'acquire', 'token': self.token, 'previous': self.old, 'candidate': self.name}, self.root)['destination'])

    def tearDown(self):
        self.root.chmod(0o700)
        self.temp.cleanup()

    @staticmethod
    def contents(name, source):
        return json.dumps({'sourceCommit': source, 'sourceDirty': False, 'version': source}).encode() if name == 'release.json' else ('fixture ' + name).encode()

    def fill(self, directory, source):
        (directory / 'fonts').mkdir()
        for name in m.FILES:
            (directory / name).write_bytes(self.contents(name, source))

    def upload(self, name='bundle.js', **overrides):
        data = self.contents(name, '2' * 40)
        request = {'op': 'upload', 'token': self.token, 'candidate': self.name, 'name': name,
                   'data': base64.b64encode(data).decode(), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        request.update(overrides)
        return m.run(request, self.root)

    def test_switch_under_readonly_public_parent_and_rollback(self):
        self.root.chmod(0o555)
        for name in m.FILES:
            self.upload(name)
        expected = m.inventory(self.candidate)
        m.run({'op': 'publish', 'token': self.token, 'expected': expected}, self.root)
        self.assertEqual(self.public.resolve(), self.candidate)
        self.assertEqual(os.readlink(self.public), 'lk-frontend-releases/current')
        m.run({'op': 'rollback', 'token': self.token}, self.root)
        m.run({'op': 'finish', 'token': self.token, 'rolledBack': True}, self.root)
        self.assertEqual(m.run({'op': 'inspect'}, self.root), self.old)
        self.assertEqual((self.root / 'lk/index.html').read_text(), 'legacy')

    def test_upload_rejects_scope_aliases_size_hash_and_overwrite(self):
        for name in ['../bundle.js', '/tmp/bundle.js', 'fonts/../bundle.js', 'index.html', 'bundle-dev.js']:
            with self.assertRaises(ValueError): self.upload(name)
        for override in [{'token': 'c'*32}, {'candidate': self.previous.name}, {'size': True}, {'size': m.MAX_ARTIFACT_BYTES + 1}, {'size': 0}, {'sha256': '0'*64}, {'data': 'invalid base64'}]:
            with self.assertRaises(ValueError): self.upload(**override)
        self.assertEqual(list(self.candidate.iterdir()), [])
        (self.candidate / 'bundle.js').symlink_to(self.previous / 'bundle.js')
        with self.assertRaises(OSError): self.upload()
        (self.candidate / 'bundle.js').unlink()
        (self.candidate / 'fonts').symlink_to(self.previous / 'fonts')
        with self.assertRaises(ValueError): self.upload('fonts/' + m.FONTS[0] + '.woff2')
        (self.candidate / 'fonts').unlink()
        self.upload()
        with self.assertRaises(FileExistsError): self.upload()
        self.assertEqual(m.inventory(self.previous), self.old)

    def test_upload_after_publish_and_foreign_public_link_refused(self):
        for name in m.FILES: self.upload(name)
        m.run({'op': 'publish', 'token': self.token, 'expected': m.inventory(self.candidate)}, self.root)
        with self.assertRaises(ValueError): self.upload()
        self.public.unlink()
        self.public.symlink_to(self.previous)
        with self.assertRaises(ValueError): m.run({'op': 'inspect'}, self.root)

    def test_dispatch_refuses_shell_commands_and_unpinned_source_before_input(self):
        code_hash = 'f' * 64
        for command in ['', 'sh', 'curl http://127.0.0.1', 'python3 -c print(1)', 'internal-sftp', 'lk-frontend-v1 ' + '0'*64, 'lk-frontend-v1 ' + code_hash + ';sh']:
            with self.assertRaisesRegex(ValueError, 'pinned static protocol'):
                m.dispatch(command, b'invalid JSON', code_hash, self.root)
        with self.assertRaisesRegex(ValueError, 'Unknown static operation'):
            m.dispatch('lk-frontend-v1 ' + code_hash, b'{"op":"shell"}', code_hash, self.root)
        with self.assertRaisesRegex(ValueError, 'too large'):
            m.dispatch('lk-frontend-v1 ' + code_hash, b'x' * (m.MAX_REQUEST_BYTES + 1), code_hash, self.root)
        self.assertEqual(m.inventory(self.previous), self.old)

if __name__ == '__main__':
    unittest.main()
