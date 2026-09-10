#!/usr/bin/env python3
"""Local rootless rehearsal of the stopped installer; no systemctl or network."""
import hashlib, json, os, shutil, tarfile, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

import install
import bundle


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class StoppedInstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='visit-install-test-', dir='/private/tmp'))
        self.uid, self.gid = os.geteuid(), os.getegid()
        self.root = self.tmp / 'root'; self.bundle = self.tmp / 'bundle'
        for path, mode in [('srv', 0o755), ('srv/lk1-subscription-dev', 0o750),
                           ('srv/lk1-subscription-dev/runtime', 0o750),
                           ('etc', 0o755), ('etc/systemd', 0o755), ('etc/systemd/system', 0o755)]:
            item = self.root / path; item.mkdir(parents=True, exist_ok=True); os.chmod(str(item), mode)
        source_mongo = Path(__file__).resolve().parents[1] / 'lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-mongo.service'
        target_mongo = self.root / ('etc/systemd/system/' + install.MONGO_UNIT)
        target_mongo.write_bytes(source_mongo.read_bytes()); os.chmod(str(target_mongo), 0o644)
        self._make_bundle()
        self.bundle_hash = digest(self.bundle / 'manifest.json')
        self.loaded = False

    def tearDown(self):
        shutil.rmtree(str(self.tmp))

    def _make_bundle(self):
        payload = self.bundle / 'payload'; payload.mkdir(parents=True)
        packet = payload / 'visit-packet'; packet.mkdir(); (packet / 'manifest.json').write_text('{"synthetic":true}\n')
        scripts = packet / 'scripts'; scripts.mkdir(); (scripts / 'entry.mjs').write_text('export default true\n')
        node = payload / 'node22/bin'; node.mkdir(parents=True); (node / 'node').write_bytes(b'node'); os.chmod(str(node / 'node'), 0o750)
        (payload / 'visit-service.env').write_text('VISIT_MANIFEST_SHA256=test\n')
        unit = payload / 'visit-unit.service'; unit.write_text('[Unit]\nRefuseManualStart=yes\n[Service]\nPrivateNetwork=yes\n')
        dropin = payload / 'mongo-dropin'; dropin.mkdir(); (dropin / '50-private-network.conf').write_text('[Service]\nPrivateNetwork=yes\n')
        source = Path(__file__).with_name('install.py'); (self.bundle / 'install.py').write_bytes(source.read_bytes()); os.chmod(str(self.bundle / 'install.py'), 0o750)
        manifest = {'format':'LK_VISIT_STOPPED_INSTALL_V1','environment':'DEV','targetHost':install.HOST,
                    'sourceDirty':False,'productionCompatible':False,'installAuthorized':False,'startAuthorized':False,
                    'nodeArchiveSha256':install.NODE_ARCHIVE_SHA256,'targets':[list(row) for row in install.TARGETS],
                    'installerSha256':digest(self.bundle / 'install.py'),'payloadInventory':install.relative_inventory(payload)}
        (self.bundle / 'manifest.json').write_text(install.canonical(manifest)); os.chmod(str(self.bundle / 'manifest.json'), 0o640)

    def _facts(self):
        unit = {'ActiveState':'inactive','UnitFileState':'disabled','LoadState':'loaded','FragmentPath':'x','DropInPaths':'',
                'RefuseManualStart':'yes','PrivateNetwork':''}
        facts = {'hostname':install.HOST,'arch':'x86_64','user':'lk1-subscription-dev:x:997:997::/srv/lk1-subscription-dev:/usr/sbin/nologin',
                 'listeners':[],'serviceProcesses':False,'units':{name:dict(unit) for name in install.LEGACY_UNITS}}
        facts['units'][install.UNIT] = {'ActiveState':'inactive','UnitFileState':'static' if self.loaded else 'disabled',
                                        'LoadState':'loaded' if self.loaded else 'not-found','FragmentPath':'x' if self.loaded else '',
                                        'DropInPaths':'','RefuseManualStart':'yes','PrivateNetwork':'yes' if self.loaded else ''}
        if self.loaded:
            facts['units'][install.MONGO_UNIT]['PrivateNetwork'] = 'yes'
            facts['units'][install.MONGO_UNIT]['DropInPaths'] = install.expected_dropin(self.root)
        return facts

    def _reload(self): self.loaded = True
    def _auth(self): return {'format':'LK_VISIT_EXACT_STOPPED_INSTALL_AUTH_V1','targetHost':install.HOST,
                              'bundleManifestSha256':self.bundle_hash,'installAuthorized':True,'startAuthorized':False}
    def _rename(self, source, target):
        self.assertFalse(Path(target).exists()); os.rename(str(source), str(target))
    def _run(self, apply=False, **kwargs):
        return install.install(self.bundle, self.bundle_hash, apply=apply, authorization=self._auth() if apply else None,
                               root=self.root, facts_fn=self._facts, reload_fn=self._reload, uid=self.uid,
                               gid_map=lambda _value: self.gid, execution=self.bundle / 'install.py', rename_fn=self._rename, **kwargs)

    def test_check_only_and_stopped_install_are_idempotent(self):
        self.assertEqual(self._run()['state'], 'CHECK_ONLY_PASS')
        self.assertEqual(self._run(apply=True)['state'], 'INSTALLED_STOPPED')
        self.assertEqual(self._run(apply=True)['state'], 'ALREADY_INSTALLED_STOPPED')
        self.assertEqual(self._run()['state'], 'CHECK_ONLY_PASS')
        self.assertFalse((self.root / 'srv/lk1-subscription-dev/authorization/visit-start.approved').exists())
        self.assertEqual((self.root / 'srv/lk1-subscription-dev/runtime/visit-install/receipt.json').read_text().find('COMPLETE') >= 0, True)

    def test_requires_separate_authorization(self):
        with self.assertRaisesRegex(install.InstallError, 'INSTALL_AUTHORIZATION_REQUIRED'):
            install.install(self.bundle, self.bundle_hash, apply=True, root=self.root, facts_fn=self._facts,
                            uid=self.uid, gid_map=lambda _value:self.gid, execution=self.bundle / 'install.py', rename_fn=self._rename)

    def test_partial_publish_is_held(self):
        def fail(event, index, _name):
            if event == 'after_publish' and index == 1: raise RuntimeError('synthetic interruption')
        with self.assertRaisesRegex(RuntimeError, 'synthetic interruption'):
            self._run(apply=True, fault=fail)
        receipt = json.loads((self.root / 'srv/lk1-subscription-dev/runtime/visit-install/receipt.json').read_text())
        self.assertEqual(receipt['state'], 'APPLYING')
        with self.assertRaisesRegex(install.InstallError, 'INSTALL_TARGET_PREEXISTS'):
            self._run()

    def test_bundle_builder_produces_a_verified_immutable_layout(self):
        runtime = self.tmp / 'runtime'; payload_file = runtime / 'scripts/lk1_subscription_visit_dev/serve.mjs'
        payload_file.parent.mkdir(parents=True); payload_file.write_text('console.log("synthetic")\n')
        packet_manifest = {'formatVersion':1,'environment':'DEV','purpose':'SYNTHETIC_PAID_JOIN_REHEARSAL',
                           'sourceDirty':False,'productionCompatible':False,'installAuthorized':False,'startAuthorized':False,
                           'files':[{'path':'scripts/lk1_subscription_visit_dev/serve.mjs','sha256':digest(payload_file)}]}
        (runtime / 'manifest.json').write_text(json.dumps(packet_manifest))
        dependencies = self.tmp / 'dependencies'; module = dependencies / 'node_modules/example'; module.mkdir(parents=True)
        (module / 'index.js').write_text('module.exports=1\n')
        closure_files=[]
        for item in sorted(dependencies.rglob('*')):
            if item.is_file(): closure_files.append({'path':item.relative_to(dependencies).as_posix(),'type':'file','sha256':digest(item)})
        inventory = self.tmp / 'inventory.json'; inventory.write_text(json.dumps({'files':closure_files}))
        audit = self.tmp / 'audit.json'; audit.write_text(json.dumps({'metadata':{'vulnerabilities':{'total':0}}}))
        archive = self.tmp / 'node.tar.xz'; source = self.tmp / 'node-v22.23.2-linux-x64/bin'; source.mkdir(parents=True)
        node = source / 'node'; node.write_bytes(b'\x7fELF' + b'\x00' * 14 + b'\x3e\x00' + b'node')
        with tarfile.open(str(archive), 'w:xz') as handle: handle.add(str(source.parent), arcname='node-v22.23.2-linux-x64')
        source_root = self.tmp / 'repo'; units = source_root / 'scripts/lk1_subscription_visit_dev/units'; units.mkdir(parents=True)
        (units / 'lk1-subscription-visit-dev.service').write_text('[Unit]\nRefuseManualStart=yes\n')
        (units / 'mongo-private-network.conf').write_text('[Service]\nPrivateNetwork=yes\n')
        fake_sha = digest(archive); output = self.tmp / 'built'
        with patch.object(bundle, 'ROOT', source_root), patch.object(bundle, 'NODE_ARCHIVE_SHA256', fake_sha), patch.object(install, 'NODE_ARCHIVE_SHA256', fake_sha), patch.object(bundle.subprocess, 'check_output', side_effect=['', 'a' * 40]):
            result = bundle.build(runtime, digest(runtime / 'manifest.json'), dependencies, inventory, audit, archive, output)
            verified = install.verify_bundle(output, result['manifestSha256'], uid=self.uid, execution=output / 'install.py')
        self.assertEqual(verified['nodeArchiveSha256'], fake_sha)


if __name__ == '__main__':
    unittest.main(verbosity=2)
