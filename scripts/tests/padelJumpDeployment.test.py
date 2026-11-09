import hashlib
import io
import json
import contextlib
import os
import shutil
import subprocess
import importlib.util
import sys
from types import SimpleNamespace
sys.dont_write_bytecode = True
from pathlib import Path
import tarfile
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).resolve().parents[1] / 'padel_jump_live_147.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

class JumpDeployment(unittest.TestCase):
    def test_both_packet_and_publisher_clis_expose_only_the_closed_instance_selector(self):
        for name in ['package_padel_jump_live_147.py', 'padel_jump_live_147.py']:
            output = subprocess.check_output([sys.executable, str(Path(__file__).resolve().parents[1] / name), '--help'], text=True)
            self.assertIn('--instance {team,exhibition}', output)

    def packager_module(self):
        spec = importlib.util.spec_from_file_location('packager', Path(__file__).resolve().parents[1] / 'package_padel_jump_live_147.py')
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

    def test_exhibition_packet_renders_isolated_ops_without_rewriting_team_defaults(self):
        packager = self.packager_module()
        self.assertTrue(hasattr(packager, 'render_ops'), 'Instance-specific ops must be rendered before packaging')
        source = 'a' * 40; community = 'fixture-event'
        team = publisher.instance_config('team'); event = publisher.instance_config('exhibition')
        anchor = publisher.ANCHOR.encode(); team_mark = ('    include ' + team['snippet'] + ';\n').encode()
        binding = {'epoch': '2026-11-09T09:00:00.000Z', 'policyRevision': 2, 'startsAt': '2026-11-11T21:00:00.000Z', 'endsAt': '2026-11-13T21:00:00.000Z', 'retentionUntil': '2027-11-13T21:00:00.000Z', 'inviteCode': 'fixture-invite'}
        original = b'server {\n' + anchor + team_mark + b'}\n'
        ops = packager.render_ops(event, source, community, binding, original)
        for name in ['ops/unit.service', 'ops/api.conf', 'ops/env.conf']: self.assertNotIn(b'padlhub-jump-live', ops[name])
        self.assertIn(b'127.0.0.1:5194;', ops['ops/api.conf']); self.assertIn(b'/jump-exhibition-api/', ops['ops/api.conf'])
        self.assertEqual(ops['ops/nginx.candidate.conf'].count(team_mark), 1)
        event_mark = ('    include ' + event['snippet'] + ';\n').encode()
        self.assertEqual(ops['ops/nginx.candidate.conf'].replace(event_mark, b''), original)
        line = next(line for line in ops['ops/env.conf'].decode().splitlines() if line.startswith('JUMP_EVENT_BINDING='))
        self.assertEqual(json.loads(line.split('=', 1)[1].strip("'")), binding)
        team_ops = packager.render_ops(team, source, community, None, b'server {\n' + anchor + b'}\n')
        expected = Path('games/padel-jump/live/deploy/unit.service.in').read_bytes().replace(b'@SOURCE@', source.encode()).replace(b'@COMMUNITY_HASH@', hashlib.sha256(community.encode()).hexdigest()[:16].encode())
        self.assertEqual(team_ops['ops/unit.service'], expected)
        self.assertEqual(team_ops['ops/api.conf'], Path('games/padel-jump/live/deploy/api.nginx.conf').read_bytes())
        with self.assertRaises(RuntimeError): packager.render_ops(event, source, community, binding, b'server {\n' + anchor + b'}\n')
        with self.assertRaises(RuntimeError): packager.render_ops(event, source, community, None, original)

    def test_packet_binding_uses_canonical_policy_and_refuses_unactivated_or_incomplete_notice(self):
        packager = self.packager_module()
        self.assertTrue(hasattr(packager, 'event_binding'), 'Packet must validate the actual canonical EVENT activation')
        policy = {'version': 'event-registration-v1', 'responsibleName': 'Synthetic Organizer', 'contactEmail': 'organizer' + '@' + 'example.invalid', 'startsAt': '2026-11-11T21:00:00.000Z', 'endsAt': '2026-11-13T21:00:00.000Z', 'retentionYears': 1}
        community = {'id': 'fixture-event', 'communityType': 'EVENT', 'typeSettingsEffectiveAt': '2026-11-09T09:00:00.000Z', 'typeSettingsRevision': 2, 'inviteCode': 'fixture-invite', 'typeSettings': {'gameIds': ['padel-jump'], 'registrationPolicy': policy}}
        binding = packager.event_binding(community)
        self.assertEqual(binding['policyRevision'], 2); self.assertEqual(binding['retentionUntil'], '2027-11-13T21:00:00.000Z')
        self.assertNotIn('contactEmail', binding)
        for override in [{'communityType': 'FRIENDS'}, {'typeSettingsRevision': 0}, {'typeSettingsEffectiveAt': 'invalid'}, {'typeSettings': {'gameIds': ['padel-jump'], 'registrationPolicy': {**policy, 'contactEmail': ''}}}]:
            with self.assertRaisesRegex(RuntimeError, 'EVENT_BINDING_INVALID'): packager.event_binding({**community, **override})

    def test_instance_selection_is_closed_and_exhibition_never_targets_team(self):
        self.assertTrue(hasattr(publisher, 'instance_config'), 'Second instance needs an explicit closed target contract')
        team = publisher.instance_config('team'); event = publisher.instance_config('exhibition')
        self.assertEqual(team['service'], 'padlhub-jump-live.service'); self.assertEqual(team['port'], 5193)
        self.assertEqual(event['service'], 'padlhub-jump-exhibition.service'); self.assertEqual(event['port'], 5194)
        self.assertEqual(event['api'], '/jump-exhibition-api/'); self.assertEqual(event['staticPrefix'], 'padel-jump-exhibition-')
        for key in ['account', 'backendRoot', 'dataRoot', 'unit', 'env', 'snippet']: self.assertNotEqual(team[key], event[key])
        for name in ['', 'TEAM', '../team', 'custom']:
            with self.assertRaises(RuntimeError): publisher.instance_config(name)

    def test_wrong_instance_plan_stops_before_snapshot_or_host_writes(self):
        with patch.object(publisher, 'snapshot') as snapshot, patch.object(publisher, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'INSTANCE_MISMATCH'):
                publisher.apply({'instance': 'exhibition', 'preimage': {}}, Path('/unused'))
            snapshot.assert_not_called(); run.assert_not_called()

    def test_exhibition_contract_rejects_team_storage_or_admission_in_either_manifest(self):
        self.assertTrue(hasattr(publisher, 'check_exhibition_contract'))
        publisher.use_instance('exhibition')
        try:
            plan = {'instance': 'exhibition', 'target': publisher.instance_config('exhibition'), 'sourceCommit': 'a' * 40, 'engine': 'e' * 64,
                    'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5, 'resultStoragePolicy': 'event-retention-v1', 'admissionContract': 'canonical-event-v1'}
            manifest = {**plan, 'sourceDirty': False}
            publisher.check_exhibition_contract(plan, manifest)
            for field, value in [('instance', 'team'), ('lives', 4), ('sync', 'old-sync'), ('resultStoragePolicy', 'permanent-v1'), ('admissionContract', 'companion-v1'), ('sourceDirty', True)]:
                with self.assertRaises(RuntimeError): publisher.check_exhibition_contract(plan, {**manifest, field: value})
                if field != 'sourceDirty':
                    with self.assertRaises(RuntimeError): publisher.check_exhibition_contract({**plan, field: value}, {**manifest, field: value})
        finally: publisher.use_instance('team')

    def test_exhibition_recovery_disconnects_only_exhibition_and_keeps_team_include(self):
        publisher.use_instance('exhibition')
        try:
            with tempfile.TemporaryDirectory() as root:
                upload = Path(root); ops = upload / 'unpacked/ops'; ops.mkdir(parents=True)
                team_mark = '    include ' + publisher.instance_config('team')['snippet'] + ';\n'
                original = (publisher.ANCHOR + team_mark).encode(); candidate = original + publisher.MARK.encode()
                (ops / 'nginx.candidate.conf').write_bytes(candidate)
                site = upload / 'site'; site.write_bytes(candidate)
                snippet = upload / 'snippet'; snippet.write_bytes(b'event-api')
                unit = upload / 'unit'; unit.write_bytes(b'event-unit')
                env = upload / 'env'; env.write_bytes(b'event-env')
                plan = {'instance': 'exhibition', 'target': publisher.instance_config('exhibition'), 'sourceCommit': 'a' * 40,
                        'preimage': {'nginx': hashlib.sha256(original).hexdigest()},
                        'files': {'ops/api.conf': publisher.sha(snippet), 'ops/unit.service': publisher.sha(unit), 'ops/env.conf': publisher.sha(env)}}
                with patch.object(publisher, 'SITE', site), patch.object(publisher, 'SNIPPET', snippet), patch.object(publisher, 'UNIT', unit), patch.object(publisher, 'ENV', env), patch.object(publisher, 'check_protected'), patch.object(publisher, 'run', return_value='') as run:
                    publisher.recover(plan, upload)
                    self.assertEqual(site.read_bytes(), original)
                    self.assertIn(('systemctl', 'disable', '--now', 'padlhub-jump-exhibition.service'), [call.args for call in run.call_args_list])
                    self.assertTrue(all('padlhub-jump-live.service' not in call.args for call in run.call_args_list))
                    self.assertEqual(env.read_bytes(), b'event-env')
        finally: publisher.use_instance('team')

    def test_exhibition_protection_rejects_a_team_restart_even_when_files_match(self):
        publisher.use_instance('exhibition')
        try:
            before = {'protected': {}, 'lkPointer': 'unchanged', 'teamRuntime': {'pid': 41, 'restarts': 0}}
            after = {**before, 'teamRuntime': {'pid': 42, 'restarts': 1}}
            with patch.object(publisher, 'snapshot', return_value=after):
                with self.assertRaisesRegex(RuntimeError, 'TEAM_RUNTIME_DRIFT'): publisher.check_protected(before)
        finally: publisher.use_instance('team')

    def exhibition_rehearsal(self, bad_env=False, bad_ops=None):
        publisher.use_instance('exhibition')
        try:
            with tempfile.TemporaryDirectory() as root:
                base = Path(root); web = base / 'web'; web.mkdir(); upload = base / 'upload'; upload.mkdir()
                old = web / 'padel-jump-team-existing'; old.mkdir(); (old / 'keep.js').write_bytes(b'unchanged-team')
                site = base / 'site'; site.write_text(publisher.ANCHOR + '    include /etc/nginx/snippets/padlhub-jump-live.conf;\n')
                source = 'a' * 40; config = publisher.instance_config('exhibition')
                binding = {'epoch': '2026-11-09T09:00:00.000Z', 'policyRevision': 2, 'startsAt': '2026-11-11T21:00:00.000Z', 'endsAt': '2026-11-13T21:00:00.000Z', 'retentionUntil': '2027-11-13T21:00:00.000Z', 'inviteCode': 'fixture-invite'}
                before = {'nginx': publisher.sha(site), 'portFree': True, 'account': None, 'group': None, 'absent': {'target': True}, 'node': 'v22.23.2', 'instance': 'exhibition', 'teamRuntime': {'pid': 41, 'restarts': 0}}
                plan = {'instance': 'exhibition', 'target': config, 'sourceCommit': source, 'communityId': 'fixture-event', 'eventBinding': binding,
                        'engine': 'e' * 64, 'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5, 'resultStoragePolicy': 'event-retention-v1', 'admissionContract': 'canonical-event-v1', 'preimage': before}
                release = {key: value for key, value in plan.items() if key in ['instance', 'sourceCommit', 'engine', 'sync', 'rule', 'lives', 'resultStoragePolicy', 'admissionContract']}
                release['sourceDirty'] = False
                files = {name: b'synthetic-frontend' for name in ['frontend/padel-jump.html', 'frontend/padel-jump-race.html', 'frontend/padel-jump-live.html', 'frontend/assets/cabinet.js']}
                files.update({'frontend/release.json': json.dumps(release).encode(), 'backend/server.mjs': b'synthetic-backend', 'backend/release.json': json.dumps({**release, 'files': {'server.mjs': {'sha256': hashlib.sha256(b'synthetic-backend').hexdigest()}}}).encode()})
                files.update(self.packager_module().render_ops(config, source, 'fixture-event', binding, site.read_bytes()))
                if bad_env: files['ops/env.conf'] = files['ops/env.conf'].replace(b'JUMP_PORT=5194', b'JUMP_PORT=5193')
                if bad_ops == 'unit': files['ops/unit.service'] = files['ops/unit.service'].replace(b'User=padlhub-jump-exhibition', b'User=padlhub-jump-live')
                if bad_ops == 'api': files['ops/api.conf'] = files['ops/api.conf'].replace(b'/jump-exhibition-api/', b'/jump-live-api/')
                with tarfile.open(upload / 'payload.tar', 'w') as archive:
                    for name, data in files.items():
                        member = tarfile.TarInfo(name); member.size = len(data); archive.addfile(member, io.BytesIO(data))
                plan.update({'archiveSha256': publisher.sha(upload / 'payload.tar'), 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}})
                class Libc:
                    def renameat2(self, source_fd, source_path, target_fd, target_path, flags):
                        if flags != 1 or os.path.lexists(target_path): return -1
                        os.rename(source_path, target_path); return 0
                health = {'engine': 'e' * 64, 'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5, 'resultStoragePolicy': 'event-retention-v1', 'communityConfigured': True, 'persistence': True}
                account = SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
                with patch.multiple(publisher, WEB=web, SITE=site, UNIT=base / 'unit', ENV=base / 'env', SNIPPET=base / 'snippet', BACKEND_ROOT=base / 'backend', DATA_ROOT=base / 'data'), patch.object(publisher, 'snapshot', return_value=before), patch.object(publisher, 'check_protected'), patch.object(publisher, 'verify', return_value={'sourceCommit': source, 'health': health}), patch.object(publisher, 'get_json', return_value=health), patch.object(publisher, 'run', return_value='') as run, patch.object(publisher.pwd, 'getpwnam', return_value=account), patch.object(publisher.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=os.getegid())), patch.object(Path, 'resolve', lambda p: p), patch('ctypes.CDLL', return_value=Libc()):
                    if bad_env or bad_ops:
                        reason = 'EXHIBITION_UNIT_DRIFT' if bad_ops == 'unit' else 'EXHIBITION_API_DRIFT' if bad_ops == 'api' else 'EXHIBITION_ENV_MISMATCH'
                        with self.assertRaisesRegex(RuntimeError, reason): publisher.apply(plan, upload)
                        run.assert_not_called(); self.assertFalse((base / 'backend').exists())
                    else:
                        receipt = publisher.apply(plan, upload)
                        self.assertEqual(receipt['status'], 'ACTIVATED')
                        self.assertIn(('systemctl', 'enable', '--now', 'padlhub-jump-exhibition.service'), [call.args for call in run.call_args_list])
                        self.assertTrue((web / ('padel-jump-exhibition-' + source[:8]) / 'assets/cabinet.js').is_file())
                        self.assertTrue((base / 'backend/releases' / source / 'server.mjs').is_file())
                        self.assertEqual((base / 'env').stat().st_mode & 0o777, 0o600)
                    self.assertEqual((old / 'keep.js').read_bytes(), b'unchanged-team')
                    self.assertTrue(all('padlhub-jump-live.service' not in call.args for call in run.call_args_list))
        finally: publisher.use_instance('team')

    def test_first_exhibition_activation_uses_only_exhibition_paths_and_commands_in_disposable_rehearsal(self): self.exhibition_rehearsal()
    def test_wrong_exhibition_env_is_rejected_before_account_or_runtime_mutation(self): self.exhibition_rehearsal(bad_env=True)
    def test_mixed_team_unit_or_api_cannot_hide_behind_template_normalization(self):
        for kind in ['unit', 'api']:
            with self.subTest(kind=kind): self.exhibition_rehearsal(bad_ops=kind)

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
            before = {'protected': {'old': frontend.sha(old)}, 'backend': {'sourceCommit': 'b' * 40, 'engine': 'e' * 64, 'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5}}
            release = {'sourceCommit': 'a' * 40, 'sourceDirty': False, 'engine': 'e' * 64, 'backendSourceCommit': 'b' * 40, 'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5}
            files = {name: b'fixture-public-html' for name in ['padel-jump.html', 'padel-jump-race.html', 'padel-jump-live.html']}; files['release.json'] = json.dumps(release).encode()
            with tarfile.open(upload / 'payload.tar', 'w') as tar:
                for name, data in files.items():
                    m = tarfile.TarInfo(name); m.size = len(data); tar.addfile(m, io.BytesIO(data))
            plan = {'sourceCommit': 'a' * 40, 'engine': 'e' * 64, 'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5, 'publisherSha256': frontend.sha(frontend.__file__), 'archiveSha256': frontend.sha(upload / 'payload.tar'), 'preimage': before, 'files': {name: frontend.digest(data) for name, data in files.items()}}
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

class ExhibitionReceiptErasure(unittest.TestCase):
    community = 'community_fixture_выставка'
    cutoff = '2027-11-13T21:00:00.000Z'

    def module(self):
        source = Path(__file__).resolve().parents[1] / 'erase_event_jump_receipts.py'
        self.assertTrue(source.is_file(), 'Canonical form erasure must also have a bounded separate-receipt path')
        spec = importlib.util.spec_from_file_location('event_receipt_erasure', source)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

    def fixture(self, root):
        root.chmod(0o700); names = []
        for index in range(4):
            record_id = str(uuid.uuid4()); name = ('.pending-' + str(uuid.uuid4())) if index == 3 else record_id + '.json'
            row = {'id': record_id, 'communityId': self.community, 'actorId': 'fixture-other' if index == 2 else 'fixture-player', 'alias': 'Private Alias',
                   'eventEpoch': '2026-11-09T09:00:00.000Z' if index != 1 else '2026-11-08T09:00:00.000Z', 'policyRevision': 2,
                   'retentionUntil': '2028-11-13T21:00:00.000Z' if index == 2 else self.cutoff}
            target = root / name; target.write_text(json.dumps(row)); target.chmod(0o600); names.append(name)
        return names

    def test_actor_erasure_covers_all_epochs_and_pending_receipts_without_touching_other_players(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); names = self.fixture(root); other = (root / names[2]).read_bytes()
            plan = module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            self.assertEqual(len(plan['files']), 3)
            preview = module.execute(plan, root)
            self.assertEqual(preview['status'], 'DRY_RUN'); self.assertEqual(len(list(root.iterdir())), 4)
            receipt = module.execute(plan, root, apply=True)
            self.assertEqual(receipt['status'], 'FILES_ERASED'); self.assertEqual(receipt['removedCount'], 3)
            self.assertEqual([p.name for p in root.iterdir()], [names[2]]); self.assertEqual((root / names[2]).read_bytes(), other)
            for value in ['fixture-player', self.community, 'Private Alias', 'actorId']: self.assertNotIn(value, json.dumps(receipt))
            with self.assertRaisesRegex(RuntimeError, 'INVENTORY_DRIFT'): module.execute(plan, root, apply=True)

    def test_expired_receipts_use_fresh_execution_time_and_the_inclusive_cutoff(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); names = self.fixture(root)
            plan = module.prepare(root, self.community, expired=True, now='2027-11-14T09:00:00.000Z')
            with patch.object(module, 'execution_now', return_value='2027-11-13T20:59:59.999Z'):
                with self.assertRaisesRegex(RuntimeError, 'NOT_EXPIRED'): module.execute(plan, root, apply=True)
            self.assertEqual(len(list(root.iterdir())), 4)
            with patch.object(module, 'execution_now', return_value=self.cutoff):
                self.assertEqual(module.execute(plan, root, apply=True)['removedCount'], 3)
            self.assertEqual([p.name for p in root.iterdir()], [names[2]])

    def test_inventory_drift_or_symlinks_stop_before_any_deletion(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); names = self.fixture(root)
            plan = module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            changed = root / names[0]; changed.write_text(changed.read_text() + ' ')
            with self.assertRaisesRegex(RuntimeError, 'INVENTORY_DRIFT'): module.execute(plan, root, apply=True)
            self.assertEqual(len(list(root.iterdir())), 4)
            changed.unlink(); changed.symlink_to(root / names[2])
            with self.assertRaises(RuntimeError): module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            self.assertTrue((root / names[2]).is_file())

    def test_ambiguous_timestamp_is_not_an_expiry_authority(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); names = self.fixture(root)
            target = root / names[0]; row = json.loads(target.read_text()); row['retentionUntil'] = self.cutoff.removesuffix('Z'); target.write_text(json.dumps(row))
            with self.assertRaisesRegex(RuntimeError, 'ROW_INVALID'): module.prepare(root, self.community, expired=True, now='2027-11-14T09:00:00.000Z')

    def test_hardlinks_public_modes_and_foreign_rows_cannot_be_an_erasure_preimage(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve(); root = base / 'receipts'; root.mkdir(); names = self.fixture(root)
            target = root / names[0]; linked = base / 'hardlink'; os.link(target, linked)
            with self.assertRaisesRegex(RuntimeError, 'FILE_INVALID'): module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            linked.unlink(); target.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'FILE_INVALID'): module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            target.chmod(0o600); row = json.loads(target.read_text()); row['communityId'] = 'foreign-community'; target.write_text(json.dumps(row))
            with self.assertRaisesRegex(RuntimeError, 'ROW_INVALID'): module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            self.assertEqual(len(list(root.iterdir())), 4)

    def test_actual_cli_prepares_private_plan_and_only_dry_runs_offline(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve(); base.chmod(0o700); root = base / 'receipts'; root.mkdir(); self.fixture(root)
            output = base / 'plan.json'
            command = [sys.executable, str(module.__file__), 'plan', '--directory', str(root), '--community-id', self.community, '--actor', 'fixture-player', '--output', str(output)]
            result = subprocess.run(command, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file(), 'CLI must create the real sealed plan, not just define helpers')
            self.assertEqual(output.stat().st_mode & 0o777, 0o600); self.assertNotIn('fixture-player', result.stdout + result.stderr)
            digest = hashlib.sha256(output.read_bytes()).hexdigest()
            preview = subprocess.run([sys.executable, str(module.__file__), 'dry-run', '--directory', str(root), '--plan', str(output), '--expected-sha', digest], text=True, capture_output=True)
            self.assertEqual(preview.returncode, 0, preview.stderr); self.assertEqual(json.loads(preview.stdout)['status'], 'DRY_RUN')
            denied = subprocess.run([sys.executable, str(module.__file__), 'apply', '--plan', str(output), '--expected-sha', digest, '--apply', '--receipt', str(base / 'result.json')], text=True, capture_output=True)
            self.assertNotEqual(denied.returncode, 0); self.assertFalse((base / 'result.json').exists()); self.assertEqual(len(list(root.iterdir())), 4)

    def test_partial_unlink_is_explicit_and_the_old_plan_cannot_be_blindly_retried(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); self.fixture(root)
            plan = module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            original = os.unlink; calls = 0
            def unlink(name, *, dir_fd=None):
                nonlocal calls
                calls += 1
                if calls == 2: raise OSError('synthetic-unlink-failure')
                return original(name, dir_fd=dir_fd)
            with patch.object(module.os, 'unlink', side_effect=unlink):
                with self.assertRaises(module.PartialErasure) as caught: module.execute(plan, root, apply=True)
            self.assertEqual(caught.exception.receipt['status'], 'PARTIAL_RECONCILE')
            self.assertEqual(caught.exception.receipt['removedCount'], 1); self.assertEqual(len(list(root.iterdir())), 3)
            with self.assertRaisesRegex(RuntimeError, 'INVENTORY_DRIFT'): module.execute(plan, root, apply=True)


    def test_final_readback_cannot_certify_changed_bytes_of_an_unselected_player(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); names = self.fixture(root)
            plan = module.prepare(root, self.community, actor='fixture-player', now='2026-11-12T09:00:00.000Z')
            original = os.unlink; changed = False
            def unlink(name, *, dir_fd=None):
                nonlocal changed
                result = original(name, dir_fd=dir_fd)
                if not changed:
                    changed = True; other = root / names[2]; row = json.loads(other.read_text()); row['alias'] = 'Changed by another writer'; other.write_text(json.dumps(row))
                return result
            with patch.object(module.os, 'unlink', side_effect=unlink):
                with self.assertRaises(module.PartialErasure) as caught: module.execute(plan, root, apply=True)
            self.assertEqual(caught.exception.receipt['status'], 'PARTIAL_RECONCILE')
            self.assertEqual(caught.exception.receipt['removedCount'], 3)


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

    def rehearsal(self, failure=False, after_publication=None, previous_policy="permanent-v1", before_reload=False):
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
                return {'pid': 2 if source == new else 1, 'sourceCommit': source, 'sha256': update.sha(releases / source / 'server.mjs'), 'health': {'engine': engine, 'sync': ('wrong-sync' if failure == 'sync' else 'full-game-v1') if source == new else None, 'rule': ('wrong-rule' if failure == 'rule' else 'five-lives-stars-v2') if source == new else 'active-total-community-v1', 'lives': 5 if source == new else None, 'resultStoragePolicy': ('wrong-policy' if failure == 'storage' else 'permanent-v1') if source == new else previous_policy, 'communityConfigured': True, 'persistence': True}}
            before = {'host': update.HOST, 'unit': original, 'protected': private_snapshot(), 'runtime': runtime(), 'data': dict(data)}
            release = {'sourceCommit': new, 'sourceDirty': False, 'engine': engine, 'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5, 'resultStoragePolicy': 'permanent-v1'}
            backend_release = {**release, 'files': {'server.mjs': {'sha256': update.digest(b'new-backend')}}}
            files = {name: b'public-fixture' for name in ['frontend/padel-jump.html', 'frontend/padel-jump-race.html', 'frontend/padel-jump-live.html']}
            files.update({'frontend/release.json': json.dumps(release).encode(), 'backend/server.mjs': b'new-backend', 'backend/release.json': json.dumps(backend_release).encode()})
            with tarfile.open(upload / 'payload.tar', 'w') as archive:
                for name, value in files.items():
                    member = tarfile.TarInfo(name); member.size = len(value); archive.addfile(member, io.BytesIO(value))
            plan = {'sourceCommit': new, 'preimage': before, 'unitCandidate': original.replace(old, new), 'engine': engine, 'sync': 'full-game-v1', 'rule': 'five-lives-stars-v2', 'lives': 5, 'resultStoragePolicy': 'permanent-v1', 'archiveSha256': update.sha(upload / 'payload.tar'), 'files': {name: update.digest(value) for name, value in files.items()}}
            commands = []; cached_source = old
            def run(*args):
                nonlocal cached_source
                commands.append(args)
                if args == ('systemctl', 'restart', update.SERVICE) and new in unit.read_text(): data['enrollments/new-private-form.json'] = 'new-private-hash'
                if args == ('systemctl', 'daemon-reload'): cached_source = new if new in unit.read_text() else old
                if args == ('systemctl', 'show', '-p', 'ExecStart', '--value', update.SERVICE): return '/usr/local/bin/node ' + str(releases / cached_source / 'server.mjs')
                if args == ('systemctl', 'show', '-p', 'WorkingDirectory', '--value', update.SERVICE): return str(releases / cached_source)
                return 'inactive' if args == ('systemctl', 'show', '-p', 'ActiveState', '--value', update.SERVICE) else ''
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
                if before_reload and path.name == 'phase-unit.json': raise RuntimeError('SYNTHETIC_BEFORE_DAEMON_RELOAD')
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
                elif failure or before_reload:
                    with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_BEFORE_DAEMON_RELOAD' if before_reload else 'RUNTIME_SYNC_DRIFT' if failure == 'sync' else 'RUNTIME_RULE_DRIFT' if failure == 'rule' else 'RUNTIME_STORAGE_POLICY_DRIFT' if failure == 'storage' else 'SYNTHETIC_VERIFY_FAILURE'): update.apply(upload, plan)
                    self.assertEqual(unit.read_text(), original if previous_policy == 'permanent-v1' else plan['unitCandidate'])
                    recovery = json.loads((upload / 'recovery-receipt.json').read_text())
                    self.assertEqual(recovery['status'], 'RECOVERED' if previous_policy == 'permanent-v1' else 'SAFE_STOPPED')
                    self.assertFalse((upload / 'receipt.json').exists())
                    if previous_policy != 'permanent-v1':
                        self.assertEqual(commands.count(('systemctl', 'restart', update.SERVICE)), 0 if before_reload else 1, 'Never restart the legacy pruner')
                        self.assertTrue(recovery['managerPermanentAndInactive']); self.assertEqual(cached_source, new)
                        self.assertIn(('systemctl', 'stop', update.SERVICE), commands)
                    self.assertFalse((web / ('padel-jump-team-' + new[:8])).exists())
                else:
                    update.apply(upload, plan); self.assertEqual(unit.read_text(), plan['unitCandidate']); self.assertEqual(json.loads((upload / 'receipt.json').read_text())['status'], 'PUBLISHED')
                self.assertEqual(data['old-result.json'], 'old-data-hash')
                if not before_reload: self.assertEqual(data['enrollments/new-private-form.json'], 'new-private-hash')
                self.assertEqual((releases / old / 'server.mjs').read_bytes(), b'old-backend'); self.assertEqual(env.read_bytes(), b'unchanged-env')
                self.assertTrue(all(cmd[0] == 'systemctl' and cmd[-1] in ['daemon-reload', update.SERVICE] for cmd in commands))

    def test_update_rehearsal_preserves_existing_and_new_private_data(self): self.rehearsal()
    def test_failed_verification_recovers_old_backend_without_deleting_new_forms(self): self.rehearsal(failure=True)
    def test_wrong_backend_sync_blocks_frontend_and_recovers_previous_backend(self): self.rehearsal(failure='sync')
    def test_wrong_backend_rule_blocks_frontend_and_recovers_previous_backend(self): self.rehearsal(failure='rule')
    def test_wrong_storage_policy_never_publishes_frontend(self): self.rehearsal(failure='storage')
    def test_legacy_pruner_is_never_restarted_after_permanent_activation(self): self.rehearsal(failure=True, previous_policy=None)
    def test_failure_between_unit_cas_and_manager_reload_cannot_cache_legacy_start(self): self.rehearsal(previous_policy=None, before_reload=True)
    def test_post_rename_fsync_failure_keeps_compatible_backend_for_readback(self): self.rehearsal(after_publication='rename-fsync')
    def test_receipt_failure_keeps_compatible_backend_for_readback(self): self.rehearsal(after_publication='receipt')




class PermanentRecoveryBeforeActivationTests(unittest.TestCase):
    def test_failed_cas_keeps_verified_legacy_runtime_unchanged_without_restart(self):
        update = JumpUpdate().module()
        with tempfile.TemporaryDirectory() as root:
            base = Path(root); unit = base / 'unit'; old = 'a' * 40; new = 'b' * 40
            releases = base / 'releases'; (releases / old).mkdir(parents=True); (releases / old / 'server.mjs').write_bytes(b'old')
            original = 'old-source'; unit.write_text(original)
            runtime = {'sourceCommit': old, 'sha256': update.sha(releases / old / 'server.mjs'), 'health': {}}
            plan = {'sourceCommit': new, 'unitCandidate': 'new-source', 'resultStoragePolicy': 'permanent-v1', 'preimage': {'unit': original, 'runtime': runtime}}
            with patch.object(update, 'UNIT', unit), patch.object(update, 'RELEASES', releases), patch.object(update, 'WEB', base / 'web'), patch.object(update, 'check_protected'), patch.object(update, 'runtime', return_value=runtime), patch.object(update, 'run') as run:
                update.recover(plan, base)
                run.assert_not_called(); self.assertEqual(unit.read_text(), original)
                self.assertEqual(json.loads((base / 'recovery-receipt.json').read_text())['status'], 'UNCHANGED_BEFORE_PERMANENT_ACTIVATION')


    def test_reload_failure_keeps_companion_stopped_and_forbids_cached_legacy_start(self):
        update = JumpUpdate().module()
        with tempfile.TemporaryDirectory() as root:
            base = Path(root); unit = base / 'unit'; old = 'a' * 40; new = 'b' * 40
            releases = base / 'releases'; (releases / old).mkdir(parents=True); (releases / old / 'server.mjs').write_bytes(b'old')
            unit.write_text('new-source')
            previous = {'sourceCommit': old, 'sha256': update.sha(releases / old / 'server.mjs'), 'health': {}}
            plan = {'sourceCommit': new, 'unitCandidate': 'new-source', 'resultStoragePolicy': 'permanent-v1', 'preimage': {'unit': 'old-source', 'runtime': previous}}
            commands = []
            def run(*args):
                commands.append(args)
                if args == ('systemctl', 'daemon-reload'): raise RuntimeError('SYNTHETIC_RELOAD_FAILURE')
                if args == ('systemctl', 'show', '-p', 'ActiveState', '--value', update.SERVICE): return 'inactive'
                return ''
            with patch.object(update, 'UNIT', unit), patch.object(update, 'RELEASES', releases), patch.object(update, 'WEB', base / 'web'), patch.object(update, 'check_protected'), patch.object(update, 'run', side_effect=run):
                with self.assertRaisesRegex(RuntimeError, 'PERMANENT_MANAGER_RECOVERY_REQUIRED'): update.recover(plan, base)
                receipt = json.loads((base / 'recovery-receipt.json').read_text())
                self.assertEqual(receipt['status'], 'SAFE_STOPPED_MANAGER_UNKNOWN'); self.assertTrue(receipt['startForbiddenUntilVerifiedReload'])
                self.assertEqual(unit.read_text(), 'new-source'); self.assertIn(('systemctl', 'stop', update.SERVICE), commands)
                self.assertNotIn(('systemctl', 'restart', update.SERVICE), commands)

if __name__ == '__main__': unittest.main()
