import hashlib
import io
import json
import contextlib
import os
import shutil
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
            before = {'protected': {'old': frontend.sha(old)}, 'backend': {'sourceCommit': 'b' * 40, 'engine': 'e' * 64, 'sync': 'full-game-v1', 'rule': 'five-lives-community-v2', 'lives': 5}}
            release = {'sourceCommit': 'a' * 40, 'sourceDirty': False, 'engine': 'e' * 64, 'backendSourceCommit': 'b' * 40, 'sync': 'full-game-v1', 'rule': 'five-lives-community-v2', 'lives': 5}
            files = {name: b'fixture-public-html' for name in ['padel-jump.html', 'padel-jump-race.html', 'padel-jump-live.html']}; files['release.json'] = json.dumps(release).encode()
            with tarfile.open(upload / 'payload.tar', 'w') as tar:
                for name, data in files.items():
                    m = tarfile.TarInfo(name); m.size = len(data); tar.addfile(m, io.BytesIO(data))
            plan = {'sourceCommit': 'a' * 40, 'engine': 'e' * 64, 'sync': 'full-game-v1', 'rule': 'five-lives-community-v2', 'lives': 5, 'publisherSha256': frontend.sha(frontend.__file__), 'archiveSha256': frontend.sha(upload / 'payload.tar'), 'preimage': before, 'files': {name: frontend.digest(data) for name, data in files.items()}}
            (upload / 'plan.json').write_text(json.dumps(plan))
            class Libc:
                def renameat2(self, source_fd, source, target_fd, target, flags):
                    if flags != 1 or source_fd != -100 or target_fd != -100: raise AssertionError('No-clobber flags required')
                    if os.path.lexists(target): return -1
                    os.rename(source, target); return 0
            with patch.object(frontend, 'WEB', web), patch.object(frontend, 'snapshot', return_value=before), patch.object(frontend.ctypes, 'CDLL', return_value=Libc()), patch.object(frontend, 'run') as run:
                for field, wrong in [('rule', 'active-total-community-v1'), ('lives', 4), ('sync', 'old-sync'), ('sync', None)]:
                    (upload / 'plan.json').write_text(json.dumps({**plan, field: wrong}))
                    with self.assertRaisesRegex(RuntimeError, 'BACKEND_SYNC_INCOMPATIBLE' if field == 'sync' else 'BACKEND_RULE_INCOMPATIBLE'): frontend.apply(upload)
                    run.assert_not_called(); self.assertFalse((web / 'padel-jump-team-aaaaaaaa').exists())
                    shutil.rmtree(upload / 'unpacked')
                (upload / 'plan.json').write_text(json.dumps(plan))
                with contextlib.redirect_stdout(io.StringIO()): frontend.apply(upload)
                run.assert_not_called()
                self.assertEqual(old.read_bytes(), b'original')
                self.assertEqual((web / 'padel-jump-team-aaaaaaaa/padel-jump-race.html').read_bytes(), files['padel-jump-race.html'])
                self.assertEqual(json.loads((upload / 'receipt.json').read_text())['status'], 'PUBLISHED')
                with self.assertRaisesRegex(RuntimeError, 'TARGET_EXISTS'): frontend.apply(upload)
                run.assert_not_called()

class JumpUpdate(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location('update', Path(__file__).resolve().parents[1] / 'update_padel_jump_live_147.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

    def test_candidate_changes_only_the_two_backend_paths(self):
        update = self.module(); old = 'a' * 40; new = 'b' * 40
        original = 'ExecStart=/usr/local/bin/node ' + str(update.RELEASES / old / 'server.mjs') + '\nWorkingDirectory=' + str(update.RELEASES / old) + '\nProtectSystem=strict\nReadWritePaths=/var/lib/padlhub-jump-live/0123456789abcdef\n'
        candidate = update.candidate_unit(original, old, new)
        self.assertEqual(candidate.replace(new, old), original)
        with self.assertRaisesRegex(RuntimeError, 'UNIT_SOURCE_DRIFT'): update.candidate_unit(original + old, old, new)
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_INVALID'): update.candidate_unit(original, old, '../escape')

    def test_update_rejects_preimage_and_active_players_before_any_publication(self):
        update = self.module()
        for current, players, reason in [({'changed': True}, [], 'HOST_PREIMAGE_DRIFT'), ({'old': True}, [{}], 'LIVE_PLAYERS_PRESENT')]:
            with tempfile.TemporaryDirectory() as root, patch.object(update, 'inventory', return_value=current), patch.object(update, 'get', return_value={'players': players}), patch.object(update, 'run') as run, patch.object(update, 'publish_directory') as publish:
                with self.assertRaisesRegex(RuntimeError, reason): update.apply(Path(root), {'preimage': {'old': True}})
                run.assert_not_called(); publish.assert_not_called()

    def test_update_archive_denies_links_traversal_and_private_files(self):
        update = self.module()
        for name, kind in [('frontend/../escape.js', tarfile.REGTYPE), ('frontend/link.js', tarfile.SYMTYPE), ('backend/private.json', tarfile.REGTYPE), ('frontend/private.json', tarfile.REGTYPE)]:
            member = tarfile.TarInfo(name); member.type = kind
            with self.assertRaises(RuntimeError): update.validate_archive([member], {'files': {name: 'fixture'}})

    def test_unit_drift_prevents_atomic_replacement(self):
        update = self.module()
        with tempfile.TemporaryDirectory() as root:
            unit = Path(root) / 'unit'; unit.write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'FILE_PREIMAGE_DRIFT'): update.write_atomic(unit, b'new', update.digest(b'expected'))
            self.assertEqual(unit.read_bytes(), b'changed')

    def test_existing_immutable_target_is_preserved(self):
        update = self.module()
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'published'; target.mkdir(); (target / 'keep').write_bytes(b'old')
            with self.assertRaisesRegex(RuntimeError, 'TARGET_EXISTS'): update.publish_directory(target, {'keep': b'new'})
            self.assertEqual((target / 'keep').read_bytes(), b'old')

    def rehearsal(self, failure=False, after_publication=None):
        update = self.module()
        with tempfile.TemporaryDirectory() as root:
            base = Path(root).resolve(); web = base / 'web'; releases = base / 'releases'; upload = base / 'upload';
            for path in [web, releases, upload]: path.mkdir()
            unit = base / 'unit'; env = base / 'env'; env.write_bytes(b'unchanged-env')
            old = 'a' * 40; new = 'b' * 40; engine = 'e' * 64
            (releases / old).mkdir(); (releases / old / 'server.mjs').write_bytes(b'old-backend')
            original = 'ExecStart=/usr/local/bin/node ' + str(releases / old / 'server.mjs') + '\nWorkingDirectory=' + str(releases / old) + '\nProtectSystem=strict\n'
            unit.write_text(original); data = {'old-result.json': 'old-data-hash'}
            def private_snapshot(ignore=None):
                return {'files': {str(p): {'sha256': update.sha(p), 'realpath': str(p)} for p in [unit, env]}, 'lkPointer': 'unchanged-pointer'}
            def runtime():
                source = new if new in unit.read_text() else old
                return {'pid': 2 if source == new else 1, 'sourceCommit': source, 'sha256': update.sha(releases / source / 'server.mjs'), 'health': {'engine': engine, 'sync': ('wrong-sync' if failure == 'sync' else 'full-game-v1') if source == new else None, 'rule': ('wrong-rule' if failure == 'rule' else 'five-lives-community-v2') if source == new else 'active-total-community-v1', 'lives': 5 if source == new else None, 'communityConfigured': True, 'persistence': True}}
            before = {'host': update.HOST, 'unit': original, 'protected': private_snapshot(), 'runtime': runtime(), 'data': dict(data)}
            release = {'sourceCommit': new, 'sourceDirty': False, 'engine': engine, 'sync': 'full-game-v1', 'rule': 'five-lives-community-v2', 'lives': 5}
            backend_release = {**release, 'files': {'server.mjs': {'sha256': update.digest(b'new-backend')}}}
            files = {name: b'public-fixture' for name in ['frontend/padel-jump.html', 'frontend/padel-jump-race.html', 'frontend/padel-jump-live.html']}
            files.update({'frontend/release.json': json.dumps(release).encode(), 'backend/server.mjs': b'new-backend', 'backend/release.json': json.dumps(backend_release).encode()})
            with tarfile.open(upload / 'payload.tar', 'w') as archive:
                for name, value in files.items():
                    member = tarfile.TarInfo(name); member.size = len(value); archive.addfile(member, io.BytesIO(value))
            plan = {'sourceCommit': new, 'preimage': before, 'unitCandidate': original.replace(old, new), 'engine': engine, 'sync': 'full-game-v1', 'rule': 'five-lives-community-v2', 'lives': 5, 'archiveSha256': update.sha(upload / 'payload.tar'), 'files': {name: update.digest(value) for name, value in files.items()}}
            commands = []
            def run(*args):
                commands.append(args)
                if args == ('systemctl', 'restart', update.SERVICE) and new in unit.read_text(): data['enrollments/new-private-form.json'] = 'new-private-hash'
                return ''
            def verify(source, expected_hash, expected_engine):
                if source == new: self.assertFalse((web / ('padel-jump-team-' + new[:8])).exists(), 'New frontend must wait for backend readiness')
                if failure is True and source == new: raise RuntimeError('SYNTHETIC_VERIFY_FAILURE')
                current = runtime(); self.assertEqual(current['sourceCommit'], source); self.assertEqual(current['sha256'], expected_hash); return current
            publish = update.publish_directory
            def publish_with_fault(target, values):
                publish(target, values)
                if after_publication == 'rename-fsync' and target.parent == web: raise OSError('SYNTHETIC_POST_RENAME_FSYNC_FAILURE')
            durable = update.durable
            def durable_with_fault(path, value):
                if after_publication == 'receipt' and path.name == 'receipt.json': raise OSError('SYNTHETIC_RECEIPT_FAILURE')
                durable(path, value)
            class Libc:
                def renameat2(self, source_fd, source, target_fd, target, flags):
                    if flags != 1 or os.path.lexists(target): return -1
                    os.rename(source, target); return 0
            with patch.object(update, 'WEB', web), patch.object(update, 'RELEASES', releases), patch.object(update, 'UNIT', unit), patch.object(update, 'inventory', return_value=before), patch.object(update, 'protected', side_effect=private_snapshot), patch.object(update, 'data_hashes', side_effect=lambda _: dict(data)), patch.object(update, 'runtime', side_effect=runtime), patch.object(update, 'get', return_value={'players': []}), patch.object(update, 'run', side_effect=run), patch.object(update, 'verify_backend', side_effect=verify), patch.object(update, 'publish_directory', side_effect=publish_with_fault), patch.object(update, 'durable', side_effect=durable_with_fault), patch.object(update.ctypes, 'CDLL', return_value=Libc()):
                if after_publication:
                    with self.assertRaisesRegex(RuntimeError, 'FRONTEND_VISIBLE_RECONCILIATION_REQUIRED'): update.apply(upload, plan)
                    self.assertEqual(unit.read_text(), plan['unitCandidate']); self.assertFalse((upload / 'recovery-receipt.json').exists())
                    self.assertTrue((web / ('padel-jump-team-' + new[:8]) / 'padel-jump-race.html').exists())
                    with self.assertRaisesRegex(RuntimeError, 'FRONTEND_VISIBLE_RECONCILIATION_REQUIRED'): update.recover(plan, upload)
                elif failure:
                    with self.assertRaisesRegex(RuntimeError, 'RUNTIME_SYNC_DRIFT' if failure == 'sync' else 'RUNTIME_RULE_DRIFT' if failure == 'rule' else 'SYNTHETIC_VERIFY_FAILURE'): update.apply(upload, plan)
                    self.assertEqual(unit.read_text(), original); self.assertTrue((upload / 'recovery-receipt.json').exists()); self.assertFalse((upload / 'receipt.json').exists())
                    self.assertFalse((web / ('padel-jump-team-' + new[:8])).exists())
                else:
                    update.apply(upload, plan); self.assertEqual(unit.read_text(), plan['unitCandidate']); self.assertEqual(json.loads((upload / 'receipt.json').read_text())['status'], 'PUBLISHED')
                self.assertEqual(data['old-result.json'], 'old-data-hash'); self.assertEqual(data['enrollments/new-private-form.json'], 'new-private-hash')
                self.assertEqual((releases / old / 'server.mjs').read_bytes(), b'old-backend'); self.assertEqual(env.read_bytes(), b'unchanged-env')
                self.assertTrue(all(cmd[0] == 'systemctl' and cmd[-1] in ['daemon-reload', update.SERVICE] for cmd in commands))

    def test_update_rehearsal_preserves_existing_and_new_private_data(self): self.rehearsal()
    def test_failed_verification_recovers_old_backend_without_deleting_new_forms(self): self.rehearsal(failure=True)
    def test_wrong_backend_sync_blocks_frontend_and_recovers_previous_backend(self): self.rehearsal(failure='sync')
    def test_wrong_backend_rule_blocks_frontend_and_recovers_previous_backend(self): self.rehearsal(failure='rule')
    def test_post_rename_fsync_failure_keeps_compatible_backend_for_readback(self): self.rehearsal(after_publication='rename-fsync')
    def test_receipt_failure_keeps_compatible_backend_for_readback(self): self.rehearsal(after_publication='receipt')

if __name__ == '__main__': unittest.main()
