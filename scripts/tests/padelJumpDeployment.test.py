import hashlib
import io
import json
import contextlib
import os
import importlib.util
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).resolve().parents[1] / 'padel_jump_live_147.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

class JumpDeployment(unittest.TestCase):
    def test_durable_creation_never_overwrites_an_existing_file(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'receipt'
            publisher.durable(p, b'original', 0o600)
            with self.assertRaises(FileExistsError): publisher.durable(p, b'replaced')
            self.assertEqual(p.read_bytes(), b'original')
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def test_nginx_replacement_requires_exact_preimage_and_preserves_mode(self):
        with tempfile.TemporaryDirectory() as root:
            site = Path(root) / 'site'; site.write_bytes(b'old'); site.chmod(0o640)
            with patch.object(publisher, 'SITE', site):
                with self.assertRaisesRegex(RuntimeError, 'PREIMAGE_DRIFT'): publisher.replace_site('0' * 64, b'bad')
                self.assertEqual(site.read_bytes(), b'old')
                publisher.replace_site(publisher.sha(site), b'new')
                self.assertEqual(site.read_bytes(), b'new'); self.assertEqual(site.stat().st_mode & 0o777, 0o640)

    def test_nginx_symlink_cannot_be_a_mutation_target(self):
        with tempfile.TemporaryDirectory() as root:
            real = Path(root) / 'real'; real.write_bytes(b'old')
            site = Path(root) / 'site'; site.symlink_to(real)
            with patch.object(publisher, 'SITE', site):
                with self.assertRaisesRegex(RuntimeError, 'PREIMAGE_DRIFT'): publisher.replace_site(publisher.sha(site), b'bad')
            self.assertEqual(real.read_bytes(), b'old')

    def test_host_drift_stops_before_unpack_or_external_mutation(self):
        with tempfile.TemporaryDirectory() as root, patch.object(publisher, 'snapshot', return_value={'nginx': 'changed'}), patch.object(publisher, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'HOST_PREIMAGE_DRIFT'): publisher.apply({'preimage': {'nginx': 'original'}}, Path(root))
            run.assert_not_called(); self.assertEqual(list(Path(root).iterdir()), [])

    def test_symlink_payload_is_rejected_before_account_or_service_changes(self):
        with tempfile.TemporaryDirectory() as root:
            upload = Path(root); archive = upload / 'payload.tar'
            with tarfile.open(archive, 'w') as tar:
                entry = tarfile.TarInfo('frontend/escape'); entry.type = tarfile.SYMTYPE; entry.linkname = '/etc/passwd'; tar.addfile(entry)
            before = {'portFree': True, 'account': None, 'group': None, 'absent': {'target': True}, 'node': 'v22.23.2'}
            plan = {'preimage': before, 'sourceCommit': 'a' * 40, 'communityId': 'community_тест', 'archiveSha256': publisher.sha(archive), 'files': {'frontend/escape': '0' * 64}}
            with patch.object(publisher, 'snapshot', return_value=before), patch.object(publisher, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'UNSAFE_ARCHIVE'): publisher.apply(plan, upload)
                run.assert_not_called()

    def test_recovery_refuses_concurrent_nginx_drift_before_any_mutation(self):
        with tempfile.TemporaryDirectory() as root:
            upload = Path(root); ops = upload / 'unpacked/ops'; ops.mkdir(parents=True)
            (ops / 'nginx.candidate.conf').write_bytes(b'candidate')
            site = upload / 'site'; site.write_bytes(b'other-team-change')
            with patch.object(publisher, 'SITE', site), patch.object(publisher, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'RECOVERY_NGINX_DRIFT'): publisher.recover({'preimage': {'nginx': hashlib.sha256(b'original').hexdigest()}}, upload)
                run.assert_not_called(); self.assertEqual(site.read_bytes(), b'other-team-change')

    def test_recovery_reloads_even_if_a_previous_attempt_already_restored_disk_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            upload = Path(root); ops = upload / 'unpacked/ops'; ops.mkdir(parents=True)
            original = b'original\n'; candidate = original + publisher.MARK.encode()
            (ops / 'nginx.candidate.conf').write_bytes(candidate)
            site = upload / 'site'; site.write_bytes(original)
            snippet = upload / 'snippet'; snippet.write_bytes(b'api')
            unit = upload / 'unit'; unit.write_bytes(b'unit')
            env = upload / 'env'; env.write_bytes(b'env')
            plan = {'sourceCommit': 'a' * 40, 'preimage': {'nginx': publisher.sha(site)}, 'files': {'ops/api.conf': publisher.sha(snippet), 'ops/unit.service': publisher.sha(unit), 'ops/env.conf': publisher.sha(env)}}
            with patch.object(publisher, 'SITE', site), patch.object(publisher, 'SNIPPET', snippet), patch.object(publisher, 'UNIT', unit), patch.object(publisher, 'ENV', env), patch.object(publisher, 'check_protected'), patch.object(publisher, 'run', return_value='') as run:
                publisher.recover(plan, upload)
                self.assertEqual(run.call_args_list[0].args, ('nginx', '-t'))
                self.assertEqual(run.call_args_list[1].args, ('systemctl', 'reload', 'nginx'))
                self.assertTrue((upload / 'recovery-receipt.json').exists())

    def test_static_packaging_omits_only_the_exact_copied_cabinet_manifest(self):
        spec = importlib.util.spec_from_file_location('packager', Path(__file__).resolve().parents[1] / 'package_padel_jump_live_147.py')
        packager = importlib.util.module_from_spec(spec); spec.loader.exec_module(packager)
        self.assertFalse(packager.include_public_artifact('manifest.json', Path('public/manifest.json').read_bytes()))
        self.assertTrue(packager.include_public_artifact('LPD.png', b'public-image-fixture'))
        with self.assertRaisesRegex(RuntimeError, 'manifest drift'): packager.include_public_artifact('manifest.json', b'changed')
        with self.assertRaisesRegex(RuntimeError, 'Unexpected public artifact'): packager.include_public_artifact('private.json', b'{}')

    def frontend_module(self):
        spec = importlib.util.spec_from_file_location('frontend', Path(__file__).resolve().parents[1] / 'publish_padel_jump_frontend_147.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

    def test_frontend_archive_rejects_traversal_links_and_private_json(self):
        frontend = self.frontend_module()
        for name, kind in [('../escape.js', tarfile.REGTYPE), ('assets/link.js', tarfile.SYMTYPE), ('private.json', tarfile.REGTYPE), ('/absolute.js', tarfile.REGTYPE)]:
            member = tarfile.TarInfo(name); member.type = kind
            with self.assertRaises(RuntimeError): frontend.validate_archive([member], {'files': {name: 'fixture'}})
        member = tarfile.TarInfo('assets/game.js'); frontend.validate_archive([member], {'files': {'assets/game.js': 'fixture'}})

    def test_frontend_preimage_drift_stops_before_unpacking_or_restart(self):
        frontend = self.frontend_module()
        with tempfile.TemporaryDirectory() as root:
            upload = Path(root); plan = {'sourceCommit': 'a' * 40, 'publisherSha256': frontend.sha(frontend.__file__), 'preimage': {'old': True}}
            (upload / 'plan.json').write_text(json.dumps(plan))
            with patch.object(frontend, 'snapshot', return_value={'drift': True}), patch.object(frontend, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'HOST_PREIMAGE_DRIFT'): frontend.apply(upload)
                run.assert_not_called(); self.assertEqual([p.name for p in upload.iterdir()], ['plan.json'])

    def test_frontend_publication_preserves_old_files_and_never_restarts_a_service(self):
        frontend = self.frontend_module()
        with tempfile.TemporaryDirectory() as root:
            base = Path(root).resolve(); upload = base / 'upload'; upload.mkdir(); web = base / 'web'; web.mkdir()
            old = web / 'old-game.html'; old.write_bytes(b'original')
            before = {'protected': {'old': frontend.sha(old)}, 'backend': {'sourceCommit': 'b' * 40, 'engine': 'e' * 64}}
            release = {'sourceCommit': 'a' * 40, 'sourceDirty': False, 'engine': 'e' * 64, 'backendSourceCommit': 'b' * 40}
            files = {name: b'fixture-public-html' for name in ['padel-jump.html', 'padel-jump-race.html', 'padel-jump-live.html']}; files['release.json'] = json.dumps(release).encode()
            with tarfile.open(upload / 'payload.tar', 'w') as tar:
                for name, data in files.items():
                    m = tarfile.TarInfo(name); m.size = len(data); tar.addfile(m, io.BytesIO(data))
            plan = {'sourceCommit': 'a' * 40, 'engine': 'e' * 64, 'publisherSha256': frontend.sha(frontend.__file__), 'archiveSha256': frontend.sha(upload / 'payload.tar'), 'preimage': before, 'files': {name: frontend.digest(data) for name, data in files.items()}}
            (upload / 'plan.json').write_text(json.dumps(plan))
            class Libc:
                def renameat2(self, source_fd, source, target_fd, target, flags):
                    if flags != 1 or source_fd != -100 or target_fd != -100: raise AssertionError('No-clobber flags required')
                    if os.path.lexists(target): return -1
                    os.rename(source, target); return 0
            with patch.object(frontend, 'WEB', web), patch.object(frontend, 'snapshot', return_value=before), patch.object(frontend.ctypes, 'CDLL', return_value=Libc()), patch.object(frontend, 'run') as run:
                with contextlib.redirect_stdout(io.StringIO()): frontend.apply(upload)
                run.assert_not_called()
                self.assertEqual(old.read_bytes(), b'original')
                self.assertEqual((web / 'padel-jump-team-aaaaaaaa/padel-jump-race.html').read_bytes(), files['padel-jump-race.html'])
                self.assertEqual(json.loads((upload / 'receipt.json').read_text())['status'], 'PUBLISHED')
                with self.assertRaisesRegex(RuntimeError, 'TARGET_EXISTS'): frontend.apply(upload)
                run.assert_not_called()

if __name__ == '__main__': unittest.main()
