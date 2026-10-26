#!/usr/bin/env python3
"""Scoped first activation and exact recovery for the isolated Jump team pilot.
Run on lk-primary-147 only; never touches LK pointers, Node-RED, or community data.
"""
import argparse
import fcntl
import hashlib
import grp
import errno
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.request
import urllib.error

HOST = '3170594-cd19972'
SITE = Path('/etc/nginx/sites-enabled/padlhub.su')
SNIPPET = Path('/etc/nginx/snippets/padlhub-jump-live.conf')
UNIT = Path('/etc/systemd/system/padlhub-jump-live.service')
ENV = Path('/etc/padlhub-jump-live.env')
ACCOUNT = 'padlhub-jump-live'
MARK = '    include /etc/nginx/snippets/padlhub-jump-live.conf;\n'
ANCHOR = '    include /etc/nginx/snippets/padlhub-padel-mix.conf;\n'

def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()

def durable(path, data, mode=0o644, exclusive=True):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC), mode)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def replace_site(expected, data):
    require(not SITE.is_symlink() and sha(SITE) == expected, 'NGINX_PREIMAGE_DRIFT')
    temporary = SITE.with_name('.padlhub-jump-' + str(os.getpid()))
    durable(temporary, data, SITE.stat().st_mode & 0o777)
    require(sha(SITE) == expected, 'NGINX_PREIMAGE_DRIFT')
    os.replace(temporary, SITE)
    fd = os.open(SITE.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def snapshot():
    require(os.geteuid() == 0 and socket.gethostname() == HOST, 'WRONG_HOST_OR_USER')
    protected = {}
    roots = [Path('/etc/nginx/sites-enabled'), Path('/etc/nginx/snippets'), Path('/etc/nginx/phab-traffic'), Path('/var/www/html/lk/padel-jump-test-834d51f8')]
    for root in roots:
        for p in sorted(root.rglob('*')):
            if p.is_file() and p != SNIPPET and p != SITE:
                protected[str(p)] = {'sha256': sha(p), 'realpath': str(p.resolve())}
    for root in [Path('/var/www/html/lk'), Path('/var/www/html/lk-frontend-current')]:
        if root.exists():
            for p in root.iterdir():
                if p.is_file():
                    protected[str(p)] = {'sha256': sha(p), 'realpath': str(p.resolve())}
    try:
        account = pwd.getpwnam(ACCOUNT).pw_uid
    except KeyError:
        account = None
    try:
        group = grp.getgrnam(ACCOUNT).gr_gid
    except KeyError:
        group = None
    s = socket.socket(); s.settimeout(1)
    try:
        port_free = s.connect_ex(('127.0.0.1', 5193)) == errno.ECONNREFUSED
    finally:
        s.close()
    return {'host': HOST, 'nginx': sha(SITE), 'nginxRealpath': str(SITE.resolve()), 'protected': protected,
            'lkPointer': str(Path('/var/www/html/lk-frontend-current').resolve()), 'portFree': port_free,
            'account': account, 'group': group, 'node': run('/usr/local/bin/node', '--version'),
            'absent': {str(p): not os.path.lexists(p) for p in [SNIPPET, UNIT, ENV, Path('/opt/padlhub-jump-live'), Path('/var/lib/padlhub-jump-live')]}}

def check_protected(before):
    current = snapshot()
    require(current['protected'] == before['protected'] and current['lkPointer'] == before['lkPointer'], 'PROTECTED_PATH_DRIFT')

def get_json(url, expected=200):
    try:
        response = urllib.request.urlopen(url, timeout=8)
    except urllib.error.HTTPError as error:
        response = error
    require(response.code == expected, 'HTTP_STATUS_' + str(response.code))
    return json.loads(response.read(1048576))

def verify(plan):
    backend = Path('/opt/padlhub-jump-live/releases') / plan['sourceCommit']
    frontend = Path('/var/www/html/lk') / ('padel-jump-team-' + plan['sourceCommit'][:8])
    require(run('systemctl', 'is-active', 'padlhub-jump-live.service') == 'active', 'SERVICE_NOT_ACTIVE')
    pid = run('systemctl', 'show', '-p', 'MainPID', '--value', 'padlhub-jump-live.service')
    require(pid.isdigit() and int(pid) > 0, 'MAINPID_MISSING')
    command = Path('/proc/' + pid + '/cmdline').read_bytes().replace(b'\0', b' ').decode()
    require(str(backend / 'server.mjs') in command, 'RUNTIME_SOURCE_DRIFT')
    require(sha(backend / 'server.mjs') == plan['files']['backend/server.mjs'], 'BACKEND_HASH_DRIFT')
    for rel, digest in plan['files'].items():
        if rel.startswith('frontend/'):
            require(sha(frontend / rel.removeprefix('frontend/')) == digest, 'FRONTEND_HASH_DRIFT')
    account = pwd.getpwnam(ACCOUNT)
    require(grp.getgrnam(ACCOUNT).gr_gid == account.pw_gid, 'RUNTIME_GROUP_MISMATCH')
    status = Path('/proc/' + pid + '/status').read_text()
    require(re.search(r'^Uid:\s+' + str(account.pw_uid) + r'\s', status, re.M), 'RUNTIME_USER_MISMATCH')
    results = Path('/var/lib/padlhub-jump-live') / hashlib.sha256(plan['communityId'].encode()).hexdigest()[:16]
    require(not results.is_symlink() and results.stat().st_uid == account.pw_uid and results.stat().st_mode & 0o777 == 0o700, 'PRIVATE_STORE_PERMISSIONS')
    for target, rel in [(UNIT, 'ops/unit.service'), (ENV, 'ops/env.conf'), (SNIPPET, 'ops/api.conf')]:
        require(sha(target) == plan['files'][rel], 'INSTALLED_CONFIG_DRIFT')
    health = get_json('http://127.0.0.1:5193/jump-live-api/health')
    require(health['engine'] == plan['engine'] and health['communityConfigured'] and health['persistence'], 'HEALTH_MISMATCH')
    denied = get_json('http://127.0.0.1:5193/jump-live-api/me', 401)
    require(denied['error'] == 'PROFILE_AUTH_REQUIRED', 'AUTH_BYPASS')
    check_protected(plan['preimage'])
    return {'sourceCommit': plan['sourceCommit'], 'engine': plan['engine'], 'mainPid': int(pid), 'backendSha256': sha(backend / 'server.mjs'), 'health': health, 'protectedUnchanged': True}

def recover(plan, upload):
    # Remove only our inserted include from a known installed candidate. Shared
    # drift is a hard stop; never restore a stale full vhost over another writer.
    candidate = (upload / 'unpacked/ops/nginx.candidate.conf').read_bytes()
    current_hash = sha(SITE)
    require(current_hash in [hashlib.sha256(candidate).hexdigest(), plan['preimage']['nginx']], 'RECOVERY_NGINX_DRIFT')
    original = candidate.replace(MARK.encode(), b'')
    require(hashlib.sha256(original).hexdigest() == plan['preimage']['nginx'], 'RECOVERY_PREIMAGE_MISMATCH')
    require(sha(SNIPPET) == plan['files']['ops/api.conf'], 'RECOVERY_SNIPPET_DRIFT')
    require(sha(UNIT) == plan['files']['ops/unit.service'] and sha(ENV) == plan['files']['ops/env.conf'], 'RECOVERY_UNIT_DRIFT')
    check_protected(plan['preimage'])
    if current_hash != plan['preimage']['nginx']:
        replace_site(current_hash, original)
    # Always validate/reload, including a retry after a prior recovery restored
    # disk bytes but lost its reload acknowledgement.
    run('nginx', '-t'); run('systemctl', 'reload', 'nginx')
    run('systemctl', 'disable', '--now', 'padlhub-jump-live.service')
    # Retain immutable payloads, unit/snippet/env, account and private receipts.
    # The snippet is inactive after removing its sole include.
    durable(upload / 'recovery-receipt.json', json.dumps({'status': 'DISCONNECTED', 'sourceCommit': plan['sourceCommit'], 'resultsPreserved': True}).encode(), 0o600)

def apply(plan, upload):
    pre = snapshot()
    require(pre == plan['preimage'], 'HOST_PREIMAGE_DRIFT')
    require(pre['portFree'] and pre['account'] is None and pre['group'] is None and all(pre['absent'].values()), 'TARGET_ALREADY_EXISTS')
    require(re.fullmatch(r'[a-f0-9]{40}', plan['sourceCommit']) and re.fullmatch(r'[\w-]{1,120}', plan['communityId']), 'PLAN_ID_INVALID')
    require(pre['node'].startswith('v22.'), 'NODE_RUNTIME_DRIFT')
    require(sha(upload / 'payload.tar') == plan['archiveSha256'], 'ARCHIVE_HASH_MISMATCH')
    unpacked = upload / 'unpacked'; unpacked.mkdir(mode=0o700)
    with tarfile.open(upload / 'payload.tar') as archive:
        members = archive.getmembers()
        require(len(members) <= 200 and {m.name for m in members} == set(plan['files']) and len(members) == len(plan['files']), 'ARCHIVE_SET_MISMATCH')
        require(sum(m.size for m in members) <= 100 * 1024 * 1024, 'ARCHIVE_TOO_LARGE')
        for member in members:
            parts = Path(member.name).parts
            require(member.isfile() and not Path(member.name).is_absolute() and '..' not in parts and len(parts) >= 2 and parts[0] in ['frontend', 'backend', 'ops'], 'UNSAFE_ARCHIVE')
            archive.extract(member, unpacked)
    for rel, digest in plan['files'].items():
        require(sha(unpacked / rel) == digest, 'PAYLOAD_HASH_MISMATCH')
    for manifest in ['frontend/release.json', 'backend/release.json']:
        value = json.loads((unpacked / manifest).read_text())
        require(value['sourceCommit'] == plan['sourceCommit'] and value['sourceDirty'] is False and value['engine'] == plan['engine'], 'MANIFEST_SOURCE_DRIFT')
    original = SITE.read_bytes(); candidate = (unpacked / 'ops/nginx.candidate.conf').read_bytes()
    require(original.count(ANCHOR.encode()) == 1 and MARK.encode() not in original and candidate == original.replace(ANCHOR.encode(), (ANCHOR + MARK).encode()), 'NGINX_SCOPE_MISMATCH')
    require(plan['files']['backend/server.mjs'] == json.loads((unpacked / 'backend/release.json').read_text())['files']['server.mjs']['sha256'], 'BACKEND_MANIFEST_HASH_MISMATCH')
    frontend = Path('/var/www/html/lk') / ('padel-jump-team-' + plan['sourceCommit'][:8])
    stage = frontend.with_name('.jump-stage-' + plan['sourceCommit'][:8])
    require(not os.path.lexists(frontend) and not os.path.lexists(stage), 'STATIC_TARGET_OR_STAGE_EXISTS')
    for parent in ['/opt', '/var/lib', '/etc/nginx/snippets', '/etc/systemd/system', '/var/www/html/lk']:
        require(Path(parent).resolve() == Path(parent), 'TARGET_PARENT_SYMLINK')
    def phase(value):
        with open(upload / 'phases.jsonl', 'a') as log:
            log.write(json.dumps({'phase': value, 'sourceCommit': plan['sourceCommit']}) + '\n'); log.flush(); os.fsync(log.fileno())
    phase('PRECONDITIONS_VERIFIED')
    # All preconditions and payload bytes are checked before first mutation.
    phase('CREATE_ISOLATED_ACCOUNT_AND_ARTIFACTS')
    run('useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', ACCOUNT)
    account = pwd.getpwnam(ACCOUNT)
    require(grp.getgrnam(ACCOUNT).gr_gid == account.pw_gid, 'DEDICATED_GROUP_MISMATCH')
    backend = Path('/opt/padlhub-jump-live/releases') / plan['sourceCommit']; backend.mkdir(parents=True, mode=0o755)
    for name in ['server.mjs', 'release.json']:
        durable(backend / name, (unpacked / 'backend' / name).read_bytes(), 0o444)
    results = Path('/var/lib/padlhub-jump-live') / hashlib.sha256(plan['communityId'].encode()).hexdigest()[:16]
    results.mkdir(parents=True, mode=0o700); os.chown(results, account.pw_uid, account.pw_gid); os.chmod(results.parent, 0o755)
    for target, rel, mode in [(ENV, 'ops/env.conf', 0o600), (UNIT, 'ops/unit.service', 0o644), (SNIPPET, 'ops/api.conf', 0o644)]:
        durable(target, (unpacked / rel).read_bytes(), mode)
    frontend = Path('/var/www/html/lk') / ('padel-jump-team-' + plan['sourceCommit'][:8])
    require(not os.path.lexists(frontend), 'STATIC_TARGET_EXISTS')
    stage = frontend.with_name('.jump-stage-' + plan['sourceCommit'][:8]); require(not os.path.lexists(stage), 'STATIC_STAGE_EXISTS')
    shutil.copytree(unpacked / 'frontend', stage); os.chmod(stage, 0o755)
    for p in stage.rglob('*'):
        os.chmod(p, 0o755 if p.is_dir() else 0o644)
    # renameat2 RENAME_NOREPLACE: preserve every earlier immutable release.
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.renameat2(-100, os.fsencode(stage), -100, os.fsencode(frontend), 1)
    require(result == 0, 'STATIC_PUBLICATION_FAILED_' + str(ctypes.get_errno()))
    run('/usr/local/bin/node', '--check', str(backend / 'server.mjs'))
    run('systemd-analyze', 'verify', str(UNIT))
    phase('START_DEDICATED_SERVICE')
    run('systemctl', 'daemon-reload'); run('systemctl', 'enable', '--now', 'padlhub-jump-live.service')
    for attempt in range(20):
        try:
            get_json('http://127.0.0.1:5193/jump-live-api/health'); break
        except (OSError, RuntimeError):
            if attempt == 19: raise
            time.sleep(0.25)
    check_protected(pre)
    durable(upload / 'nginx.preimage.conf', original, 0o600)
    phase('ACTIVATE_NEW_NGINX_INCLUDE')
    replace_site(pre['nginx'], candidate)
    try:
        run('nginx', '-t'); run('systemctl', 'reload', 'nginx')
    except Exception:
        # Prior config remains valid, but no implicit destructive recovery.
        # Preserve phase/preimage; operator invokes exact recover after readback.
        durable(upload / 'activation-failed.json', json.dumps({'phase': 'NGINX_VALIDATE_OR_RELOAD', 'sourceCommit': plan['sourceCommit']}).encode(), 0o600)
        raise
    phase('VERIFY_RUNTIME_AND_PROTECTED_PATHS')
    receipt = {'status': 'ACTIVATED', **verify(plan), 'nginxSha256': sha(SITE), 'url': 'https://padlhub.su/lk/' + frontend.name + '/padel-jump-race.html', 'liveUrl': 'https://padlhub.su/lk/' + frontend.name + '/padel-jump-live.html'}
    durable(upload / 'activation-receipt.json', json.dumps(receipt, indent=2).encode(), 0o600)
    return receipt

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('operation', choices=['inventory', 'apply', 'verify', 'recover']); parser.add_argument('--upload', type=Path)
    args = parser.parse_args(); require(os.geteuid() == 0 and socket.gethostname() == HOST, 'WRONG_HOST_OR_USER')
    with open('/run/lock/padlhub-jump-live.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.operation == 'inventory': print(json.dumps(snapshot(), indent=2)); return
        require(args.upload and re.fullmatch(r'/var/tmp/padlhub-jump-live\.[A-Za-z0-9]{8}', str(args.upload)), 'UPLOAD_PATH_INVALID')
        plan = json.loads((args.upload / 'plan.json').read_text())
        require(sha(__file__) == plan['publisherSha256'], 'PUBLISHER_SOURCE_DRIFT')
        if args.operation == 'apply': print(json.dumps(apply(plan, args.upload), indent=2))
        elif args.operation == 'verify': print(json.dumps(verify(plan), indent=2))
        else: recover(plan, args.upload); print('DISCONNECTED; results preserved')

if __name__ == '__main__':
    main()
