#!/usr/bin/env python3
"""Fail-closed installer for the stopped, isolated subscription-visit DEV service.

The default mode performs only verification.  ``--apply-stopped`` needs a separate,
exact authorization document and never starts, enables, restarts, or stops a unit.
"""
from __future__ import print_function

import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

HOST = '89-108-64-209.cloudvps.regruhosting.ru'
BASE = '/srv/lk1-subscription-dev'
UNIT = 'lk1-subscription-visit-dev.service'
MONGO_UNIT = 'lk1-subscription-dev-mongo.service'
SERVICE_USER = 'lk1-subscription-dev'
SERVICE_UID = 997
SERVICE_GID = 997
MONGO_UNIT_SHA256 = '370f07b518f14d87ba78d2cdc3e3cd15714349cf664d2bf53ac95ec2125a9980'
NODE_ARCHIVE_SHA256 = 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307'
LEGACY_UNITS = [MONGO_UNIT, 'lk1-subscription-dev-nodered.service',
                'lk1-subscription-dev-provider-fixture.service',
                'lk1-subscription-dev-cup.service',
                'lk1-subscription-dev-identity-fixture.service']
TARGETS = [
    ('visit-packet', BASE + '/visit-packet', SERVICE_GID, 0o750),
    ('node22', BASE + '/runtime/node22', SERVICE_GID, 0o750),
    ('visit-service.env', BASE + '/visit-service.env', SERVICE_GID, 0o640),
    ('visit-unit.service', '/etc/systemd/system/' + UNIT, 0, 0o644),
    ('mongo-dropin', '/etc/systemd/system/' + MONGO_UNIT + '.d', 0, 0o755),
]


class InstallError(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise InstallError(code)


def sha256(path):
    digest = hashlib.sha256()
    with open(str(path), 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n'


def target_at(root, absolute):
    require(absolute.startswith('/'), 'INSTALL_TARGET_NOT_ABSOLUTE')
    root = Path(root).resolve()
    target = root.joinpath(*Path(absolute).parts[1:])
    require(target.parent.resolve().is_relative_to(root) if hasattr(Path('.'), 'is_relative_to')
            else str(target.parent.resolve()).startswith(str(root) + os.sep), 'INSTALL_TARGET_ESCAPE')
    return target


def protected(path, uid):
    """Reject a source or target below an untrusted writable ancestor."""
    item = Path(path).absolute()
    while True:
        try:
            info = item.lstat()
        except OSError:
            raise InstallError('INSTALL_PROTECTED_PATH_MISSING:' + str(item))
        require(not stat.S_ISLNK(info.st_mode), 'INSTALL_PROTECTED_SYMLINK:' + str(item))
        mode = stat.S_IMODE(info.st_mode)
        require(info.st_uid in (0, uid), 'INSTALL_PROTECTED_OWNER:' + str(item))
        writable = bool(mode & 0o022)
        sticky_tmp = bool(mode & stat.S_ISVTX) and item in (Path('/tmp'), Path('/private/tmp'))
        require(not writable or sticky_tmp, 'INSTALL_PROTECTED_WRITABLE:' + str(item))
        if item.parent == item or (uid != 0 and item.parent in (Path('/tmp'), Path('/private/tmp'))):
            return
        item = item.parent


def relative_inventory(root):
    root = Path(root)
    result = []
    for item in sorted(root.rglob('*'), key=lambda p: str(p.relative_to(root))):
        rel = item.relative_to(root).as_posix()
        info = item.lstat()
        require(not (info.st_mode & (stat.S_ISUID | stat.S_ISGID)), 'INSTALL_SETID_PAYLOAD:' + rel)
        if stat.S_ISLNK(info.st_mode):
            link = os.readlink(str(item))
            resolved = (item.parent / link).resolve()
            require(str(resolved).startswith(str(root.resolve()) + os.sep), 'INSTALL_SYMLINK_ESCAPE:' + rel)
            result.append({'path': rel, 'type': 'symlink', 'link': link})
        elif stat.S_ISDIR(info.st_mode):
            result.append({'path': rel, 'type': 'directory'})
        elif stat.S_ISREG(info.st_mode):
            require(info.st_nlink == 1, 'INSTALL_HARDLINK_PAYLOAD:' + rel)
            result.append({'path': rel, 'type': 'file', 'sha256': sha256(item),
                           'executable': bool(info.st_mode & 0o111)})
        else:
            raise InstallError('INSTALL_SPECIAL_PAYLOAD:' + rel)
    return result


def manifest_hash(bundle):
    return sha256(Path(bundle) / 'manifest.json')


def verify_bundle(bundle, expected_hash, uid=0, execution=None):
    bundle = Path(bundle).resolve()
    protected(bundle, uid)
    require(manifest_hash(bundle) == expected_hash, 'INSTALL_MANIFEST_SHA256')
    require(set(p.name for p in bundle.iterdir()) == {'manifest.json', 'install.py', 'payload'},
            'INSTALL_BUNDLE_LAYOUT')
    manifest = json.loads((bundle / 'manifest.json').read_text())
    require(manifest.get('format') == 'LK_VISIT_STOPPED_INSTALL_V1', 'INSTALL_MANIFEST_FORMAT')
    require(manifest.get('targetHost') == HOST and manifest.get('environment') == 'DEV', 'INSTALL_MANIFEST_TARGET')
    require(manifest.get('sourceDirty') is False and manifest.get('productionCompatible') is False and manifest.get('installAuthorized') is False
            and manifest.get('startAuthorized') is False, 'INSTALL_MANIFEST_GUARD')
    require(manifest.get('nodeArchiveSha256') == NODE_ARCHIVE_SHA256, 'INSTALL_NODE_ARCHIVE_SHA256')
    require(manifest.get('targets') == [list(row) for row in TARGETS], 'INSTALL_MANIFEST_TARGETS')
    execution = Path(execution or __file__).resolve()
    require(sha256(execution) == manifest.get('installerSha256'), 'INSTALL_EXECUTION_IDENTITY')
    require(relative_inventory(bundle / 'payload') == manifest.get('payloadInventory'), 'INSTALL_PAYLOAD_INVENTORY')
    return manifest


def read_authorization(authorization, expected_hash):
    require(isinstance(authorization, dict), 'INSTALL_AUTHORIZATION_REQUIRED')
    require(authorization.get('format') == 'LK_VISIT_EXACT_STOPPED_INSTALL_AUTH_V1', 'INSTALL_AUTHORIZATION_FORMAT')
    require(authorization.get('targetHost') == HOST, 'INSTALL_AUTHORIZATION_HOST')
    require(authorization.get('bundleManifestSha256') == expected_hash, 'INSTALL_AUTHORIZATION_BUNDLE')
    require(authorization.get('installAuthorized') is True and authorization.get('startAuthorized') is False,
            'INSTALL_AUTHORIZATION_SCOPE')


def live_facts():
    def unit(name):
        fields = 'ActiveState,UnitFileState,LoadState,FragmentPath,DropInPaths,RefuseManualStart,PrivateNetwork'
        values = subprocess.check_output(['systemctl', 'show', name, '--no-pager', '--property=' + fields], text=True)
        return dict(line.split('=', 1) for line in values.splitlines() if '=' in line)
    listeners = subprocess.check_output(['ss', '-H', '-ltn'], text=True).splitlines()
    return {
        'hostname': platform.node(), 'arch': platform.machine(),
        'user': subprocess.check_output(['getent', 'passwd', SERVICE_USER], text=True).strip(),
        'units': {name: unit(name) for name in LEGACY_UNITS + [UNIT]},
        'listeners': listeners,
        'serviceProcesses': subprocess.call(['pgrep', '-u', str(SERVICE_UID)], stdout=subprocess.DEVNULL,
                                             stderr=subprocess.DEVNULL) == 0,
    }


def expected_dropin(root):
    return str(target_at(root, '/etc/systemd/system/' + MONGO_UNIT + '.d' + '/50-private-network.conf'))


def preflight(root, facts, installed, uid):
    require(facts['hostname'] == HOST and facts['arch'] == 'x86_64', 'INSTALL_HOST_IDENTITY')
    user = facts['user'].split(':')
    require(len(user) == 7 and user[0] == SERVICE_USER and user[2:4] == [str(SERVICE_UID), str(SERVICE_GID)],
            'INSTALL_SERVICE_IDENTITY')
    require(not facts['serviceProcesses'], 'INSTALL_SERVICE_PROCESS_RUNNING')
    for listener in facts['listeners']:
        fields = listener.split()
        if len(fields) >= 4:
            local = fields[3]
            require(not any(local.endswith(':' + str(port)) for port in (1882, 3038, 27030)),
                    'INSTALL_PORT_OCCUPIED:' + local)
    for name in LEGACY_UNITS:
        state = facts['units'][name]
        require(state.get('ActiveState') == 'inactive' and state.get('UnitFileState') == 'disabled',
                'INSTALL_LEGACY_UNIT_ACTIVE:' + name)
    visit = facts['units'][UNIT]
    if installed:
        require(visit.get('LoadState') == 'loaded' and visit.get('UnitFileState') == 'static'
                and visit.get('RefuseManualStart') == 'yes' and visit.get('PrivateNetwork') == 'yes',
                'INSTALL_VISIT_UNIT_LOADED')
        require(facts['units'][MONGO_UNIT].get('PrivateNetwork') == 'yes', 'INSTALL_MONGO_PRIVATE_NETWORK')
        require(facts['units'][MONGO_UNIT].get('DropInPaths') == expected_dropin(root), 'INSTALL_MONGO_DROPIN')
    else:
        require(visit.get('LoadState') in ('not-found', 'masked'), 'INSTALL_VISIT_UNIT_PREEXISTS')
    mongo = target_at(root, '/etc/systemd/system/' + MONGO_UNIT)
    require(mongo.is_file() and sha256(mongo) == MONGO_UNIT_SHA256, 'INSTALL_MONGO_UNIT_PREIMAGE')
    for path in [target_at(root, BASE), target_at(root, BASE + '/runtime'), target_at(root, '/etc/systemd/system')]:
        protected(path, uid)
    for marker in ('visit-start.approved', 'service-start.approved'):
        require(not target_at(root, BASE + '/authorization/' + marker).exists(), 'INSTALL_START_MARKER_PRESENT')


def chmod_tree(root, owner_uid, gid):
    root = Path(root)
    for item in [root] + list(root.rglob('*')):
        if item.is_symlink():
            os.lchown(str(item), owner_uid, gid)
        else:
            os.chown(str(item), owner_uid, gid)
            info = item.stat()
            os.chmod(str(item), 0o750 if item.is_dir() or (info.st_mode & 0o111) else 0o640)


def copy_target(source, staging, gid, owner_uid=0):
    source, staging = Path(source), Path(staging)
    if source.is_dir():
        shutil.copytree(str(source), str(staging), symlinks=True, copy_function=shutil.copy2)
        chmod_tree(staging, owner_uid, gid)
    else:
        staging.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(source), str(staging))
        os.chown(str(staging), owner_uid, gid)
        os.chmod(str(staging), 0o750 if os.stat(str(staging)).st_mode & 0o111 else 0o640)


def rename_new(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        func = libc.renameat2
    except AttributeError:
        raise InstallError('INSTALL_RENAMEAT2_UNAVAILABLE')
    result = func(-100, os.fsencode(str(source)), -100, os.fsencode(str(target)), 1)  # RENAME_NOREPLACE
    if result:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise InstallError('INSTALL_TARGET_ALREADY_EXISTS:' + str(target))
        raise InstallError('INSTALL_RENAME_FAILED:' + os.strerror(code))


def save_receipt(path, receipt):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.tmp')
    with open(str(temporary), 'w') as handle:
        handle.write(canonical(receipt)); handle.flush(); os.fsync(handle.fileno())
    os.replace(str(temporary), str(path))


def load_receipt(path):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else None


def install(bundle, expected_hash, apply=False, authorization=None, root='/', facts_fn=live_facts,
            reload_fn=None, uid=0, gid_map=None, fault=None, execution=None, rename_fn=None):
    require(os.geteuid() == uid, 'INSTALL_ROOT_REQUIRED')
    manifest = verify_bundle(bundle, expected_hash, uid=uid, execution=execution)
    if apply:
        read_authorization(authorization, expected_hash)
    root = Path(root).resolve()
    base = target_at(root, BASE)
    journal = base / 'runtime/visit-install'
    receipt_path = journal / 'receipt.json'
    receipt = load_receipt(receipt_path)
    facts = facts_fn()
    installed = bool(receipt and receipt.get('state') == 'COMPLETE')
    preflight(root, facts, installed, uid)
    for name, absolute, _gid, _mode in TARGETS:
        target = target_at(root, absolute)
        if installed:
            require(target.exists() and not target.is_symlink(), 'INSTALL_TARGET_MISSING:' + name)
            require(relative_inventory(target) == relative_inventory(Path(bundle) / 'payload' / name)
                    if target.is_dir() else sha256(target) == sha256(Path(bundle) / 'payload' / name),
                    'INSTALL_TARGET_DRIFT:' + name)
        else:
            require(not target.exists() and not target.is_symlink(), 'INSTALL_TARGET_PREEXISTS:' + name)
    if not apply:
        return {'state': 'CHECK_ONLY_PASS', 'manifestSha256': expected_hash}
    if installed:
        return {'state': 'ALREADY_INSTALLED_STOPPED', 'manifestSha256': expected_hash}
    journal.mkdir(parents=True, exist_ok=True)
    protected(journal, uid)
    lock_path = base / 'runtime/.visit-install.lock'
    with open(str(lock_path), 'a+') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt = {'format': 'LK_VISIT_STOPPED_INSTALL_RECEIPT_V1', 'state': 'APPLYING',
                   'manifestSha256': expected_hash, 'published': []}
        save_receipt(receipt_path, receipt)
        rename_fn = rename_fn or rename_new
        gid_map = gid_map or (lambda value: value)
        for index, (name, absolute, gid, mode) in enumerate(TARGETS):
            target = target_at(root, absolute)
            temporary = target.with_name('.' + target.name + '.visit-install')
            require(not temporary.exists(), 'INSTALL_STAGING_PREEXISTS:' + name)
            copy_target(Path(bundle) / 'payload' / name, temporary, gid_map(gid), uid)
            if temporary.is_dir():
                os.chmod(str(temporary), mode)
            else:
                os.chmod(str(temporary), mode)
            rename_fn(temporary, target)
            receipt['published'].append(name); save_receipt(receipt_path, receipt)
            if fault:
                fault('after_publish', index, name)
        (reload_fn or (lambda: subprocess.check_call(['systemctl', 'daemon-reload'])))()
        preflight(root, facts_fn(), True, uid)
        receipt['state'] = 'COMPLETE'; save_receipt(receipt_path, receipt)
        return {'state': 'INSTALLED_STOPPED', 'manifestSha256': expected_hash}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('bundle'); parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--apply-stopped', action='store_true'); parser.add_argument('--authorization')
    args = parser.parse_args()
    authorization = json.loads(Path(args.authorization).read_text()) if args.authorization else None
    result = install(args.bundle, args.manifest_sha256, apply=args.apply_stopped, authorization=authorization)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
