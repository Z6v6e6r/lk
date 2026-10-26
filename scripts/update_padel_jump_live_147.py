#!/usr/bin/env python3
"""Guarded update of the existing isolated Jump service and immutable frontend."""
import argparse
import ctypes
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.request

HOST = '3170594-cd19972'
WEB = Path('/var/www/html/lk')
RELEASES = Path('/opt/padlhub-jump-live/releases')
UNIT = Path('/etc/systemd/system/padlhub-jump-live.service')
SERVICE = 'padlhub-jump-live.service'

def require(ok, message):
    if not ok: raise RuntimeError(message)

def digest(data): return hashlib.sha256(data).hexdigest()
def sha(path): return digest(Path(path).read_bytes())
def run(*args): return subprocess.check_output(args, text=True).strip()
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:5193/jump-live-api/' + path, timeout=3) as response: return json.load(response)

def protected(ignore=None):
    paths = {}
    roots = [Path('/etc/nginx/sites-enabled'), Path('/etc/nginx/snippets'), Path('/etc/nginx/phab-traffic')]
    roots += sorted(p for p in WEB.glob('padel-jump-*') if p.is_dir() and p != ignore)
    for root in roots:
        for path in sorted(root.rglob('*')):
            if path.is_file(): paths[str(path)] = {'sha256': sha(path), 'realpath': str(path.resolve())}
    for root in [WEB, Path('/var/www/html/lk-frontend-current')]:
        for path in root.iterdir():
            if path.is_file(): paths[str(path)] = {'sha256': sha(path), 'realpath': str(path.resolve())}
    for path in [UNIT, Path('/etc/padlhub-jump-live.env')]: paths[str(path)] = {'sha256': sha(path), 'realpath': str(path.resolve())}
    return {'files': paths, 'lkPointer': str(Path('/var/www/html/lk-frontend-current').resolve())}

def data_hashes(unit):
    matches = re.findall(r'^ReadWritePaths=(/var/lib/padlhub-jump-live/[a-f0-9]{16})$', unit, re.M)
    require(len(matches) == 1, 'PRIVATE_STORE_UNKNOWN')
    root = Path(matches[0]); require(root.resolve() == root, 'PRIVATE_STORE_SYMLINK')
    result = {}
    for path in root.rglob('*'):
        require(not path.is_symlink(), 'PRIVATE_DATA_SYMLINK')
        if path.is_file(): result[str(path.relative_to(root))] = sha(path)
    return result

def runtime():
    require(run('systemctl', 'is-active', SERVICE) == 'active', 'SERVICE_NOT_ACTIVE')
    pid = run('systemctl', 'show', '-p', 'MainPID', '--value', SERVICE)
    args = Path('/proc/' + pid + '/cmdline').read_bytes().split(b'\0'); backend = args[1].decode()
    match = re.fullmatch(str(RELEASES) + r'/([a-f0-9]{40})/server.mjs', backend); require(match, 'RUNTIME_UNKNOWN')
    return {'pid': int(pid), 'sourceCommit': match[1], 'sha256': sha(backend), 'health': get('health')}

def inventory():
    unit = UNIT.read_text()
    return {'host': HOST, 'protected': protected(), 'unit': unit, 'runtime': runtime(), 'data': data_hashes(unit)}

def candidate_unit(original, previous, source):
    require(re.fullmatch(r'[a-f0-9]{40}', previous) and re.fullmatch(r'[a-f0-9]{40}', source), 'SOURCE_INVALID')
    require(original.count(previous) == 2 and source not in original, 'UNIT_SOURCE_DRIFT')
    require('ExecStart=/usr/local/bin/node ' + str(RELEASES / previous / 'server.mjs') in original and 'WorkingDirectory=' + str(RELEASES / previous) in original, 'UNIT_TOPOLOGY_DRIFT')
    return original.replace(previous, source)

def write_atomic(path, data, expected):
    require(not path.is_symlink() and sha(path) == expected, 'FILE_PREIMAGE_DRIFT')
    fd, name = tempfile.mkstemp(prefix='.jump-unit-', dir=path.parent)
    try:
        os.fchmod(fd, path.stat().st_mode & 0o777)
        remaining = memoryview(data)
        while remaining:
            written = os.write(fd, remaining); require(written > 0, 'UNIT_WRITE_FAILED'); remaining = remaining[written:]
        os.fsync(fd); os.close(fd); fd = None
        require(sha(path) == expected, 'FILE_PREIMAGE_DRIFT'); os.replace(name, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if fd is not None: os.close(fd)
        if os.path.exists(name): os.unlink(name)

def durable(path, value):
    with path.open('x') as stream: json.dump(value, stream, indent=2); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def publish_directory(target, files):
    require(not os.path.lexists(target) and target.parent.resolve() == target.parent, 'TARGET_EXISTS_OR_SYMLINK')
    stage = Path(tempfile.mkdtemp(prefix='.jump-update-', dir=target.parent))
    for name, data in files.items():
        path = stage / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data); path.chmod(0o644)
        with path.open('rb') as stream: os.fsync(stream.fileno())
    for path in [stage, *[p for p in stage.rglob('*') if p.is_dir()]]: path.chmod(0o755)
    for path in sorted([stage, *[p for p in stage.rglob('*') if p.is_dir()]], key=lambda p: len(p.parts), reverse=True):
        fd = os.open(path, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.renameat2(-100, os.fsencode(stage), -100, os.fsencode(target), 1) == 0, 'NO_CLOBBER_PUBLICATION_FAILED')
    fd = os.open(target.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def validate_archive(members, plan):
    require(len(members) == len(plan['files']) <= 152 and {m.name for m in members} == set(plan['files']), 'ARCHIVE_SET_DRIFT')
    require(sum(m.size for m in members) <= 50 * 1024 * 1024, 'ARCHIVE_SIZE_LIMIT')
    for member in members:
        path = Path(member.name)
        require(member.isfile() and not path.is_absolute() and '..' not in path.parts and member.name == str(path) and len(path.parts) >= 2, 'UNSAFE_ARCHIVE')
        require(path.parts[0] == 'frontend' and (path.suffix in ['.html', '.js', '.css', '.svg', '.webp', '.png', '.ico'] or member.name == 'frontend/release.json') or member.name in ['backend/server.mjs', 'backend/release.json'], 'UNEXPECTED_PAYLOAD')

def package(args):
    require(args.output and args.preimage and len(args.ci) == 2, 'PACKAGE_INPUTS_REQUIRED')
    require(not run('git', 'status', '--porcelain'), 'DIRTY_SOURCE')
    source = run('git', 'rev-parse', 'HEAD'); branch = run('git', 'branch', '--show-current')
    require(branch.startswith('codex/') and run('git', 'rev-parse', 'origin/' + branch) == source, 'UNPUSHED_SOURCE')
    checks = [json.loads(path.read_text()) for path in args.ci]
    require(all(c['headSha'] == source and c['status'] == 'completed' and c['conclusion'] == 'success' for c in checks), 'CI_NOT_GREEN')
    before = json.loads(args.preimage.read_text()); unit = candidate_unit(before['unit'], before['runtime']['sourceCommit'], source)
    subprocess.run(['npm', 'run', 'build:jump-live'], check=True); subprocess.run(['npx', 'vite', 'build', '--config', 'games/padel-jump/vite.config.ts'], check=True)
    require(not run('git', 'status', '--porcelain') and run('git', 'rev-parse', 'HEAD') == source, 'SOURCE_BUILD_DRIFT')
    files = {}
    for path in Path('dist/padel-jump').rglob('*'):
        require(not path.is_symlink(), 'STATIC_SYMLINK')
        if not path.is_file(): continue
        name = str(path.relative_to('dist/padel-jump')); data = path.read_bytes()
        if name == 'manifest.json': require(data == Path('public/manifest.json').read_bytes(), 'PUBLIC_MANIFEST_DRIFT'); continue
        require(path.suffix in ['.html', '.js', '.css', '.svg', '.webp', '.png', '.ico'], 'UNEXPECTED_PUBLIC_FILE'); files['frontend/' + name] = data
    backend = json.loads(Path('dist/padel-jump-live/release.json').read_text())
    require(backend['sourceCommit'] == source and backend['sourceDirty'] is False and backend['engine'] == before['runtime']['health']['engine'], 'BACKEND_INCOMPATIBLE')
    require(backend.get('sync') == 'full-game-v1', 'BACKEND_SYNC_INCOMPATIBLE')
    require(backend.get('rule') == 'five-lives-stars-v2' and backend.get('lives') == 5, 'BACKEND_RULE_INCOMPATIBLE')
    for name in ['server.mjs', 'release.json']: files['backend/' + name] = Path('dist/padel-jump-live', name).read_bytes()
    require(digest(files['backend/server.mjs']) == backend['files']['server.mjs']['sha256'], 'BACKEND_HASH_DRIFT')
    release = {'schema': 'PADLHUB_JUMP_ADMISSION_V1', 'sourceCommit': source, 'sourceDirty': False, 'engine': backend['engine'], 'sync': backend['sync'], 'rule': backend['rule'], 'lives': backend['lives'], 'ciRuns': [c['url'] for c in checks], 'files': {n.removeprefix('frontend/'): {'sha256': digest(d), 'size': len(d)} for n, d in files.items() if n.startswith('frontend/')}}
    files['frontend/release.json'] = (json.dumps(release, indent=2) + '\n').encode()
    args.output.mkdir(mode=0o700)
    with tarfile.open(args.output / 'payload.tar', 'w') as archive:
        for name, data in sorted(files.items()):
            entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o644; archive.addfile(entry, io.BytesIO(data))
    code = Path(__file__).read_bytes(); (args.output / 'publisher.py').write_bytes(code)
    plan = {'sourceCommit': source, 'preimage': before, 'unitCandidate': unit, 'engine': backend['engine'], 'sync': backend['sync'], 'rule': backend['rule'], 'lives': backend['lives'], 'publisherSha256': digest(code), 'archiveSha256': sha(args.output / 'payload.tar'), 'files': {n: digest(d) for n, d in files.items()}}
    (args.output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n'); (args.output / 'release.json').write_bytes(files['frontend/release.json'])
    print(json.dumps({'sourceCommit': source, 'files': len(files), 'archiveSha256': plan['archiveSha256']}))

def check_protected(plan, target, expected_unit, exact_data=False):
    current = protected(ignore=target); before = plan['preimage']['protected']
    require(current['files'].pop(str(UNIT)) == {'sha256': digest(expected_unit.encode()), 'realpath': str(UNIT)}, 'UNIT_DRIFT')
    expected = dict(before['files']); expected.pop(str(UNIT))
    require(current == {'files': expected, 'lkPointer': before['lkPointer']}, 'PROTECTED_PATH_DRIFT')
    current_data = data_hashes(plan['preimage']['unit']); prior_data = plan['preimage']['data']
    require(current_data == prior_data if exact_data else all(current_data.get(name) == value for name, value in prior_data.items()), 'PRIVATE_DATA_DRIFT')

def verify_backend(source, expected_hash, engine):
    last = None
    for _ in range(12):
        try:
            current = runtime(); require(current['sourceCommit'] == source and current['sha256'] == expected_hash and current['health']['engine'] == engine and current['health']['communityConfigured'] and current['health']['persistence'], 'RUNTIME_DRIFT'); return current
        except Exception as error: last = error; time.sleep(0.5)
    raise last

def recover(plan, upload):
    target = WEB / ('padel-jump-team-' + plan['sourceCommit'][:8]); unit_hash = sha(UNIT)
    require(not os.path.lexists(target), 'FRONTEND_VISIBLE_RECONCILIATION_REQUIRED')
    require(unit_hash in [digest(plan['unitCandidate'].encode()), digest(plan['preimage']['unit'].encode())], 'RECOVERY_UNIT_DRIFT')
    expected_unit = plan['unitCandidate'] if unit_hash == digest(plan['unitCandidate'].encode()) else plan['preimage']['unit']
    check_protected(plan, target, expected_unit)
    old = plan['preimage']['runtime']; require(sha(RELEASES / old['sourceCommit'] / 'server.mjs') == old['sha256'], 'RECOVERY_BACKEND_DRIFT')
    if unit_hash != digest(plan['preimage']['unit'].encode()): write_atomic(UNIT, plan['preimage']['unit'].encode(), unit_hash)
    run('systemctl', 'daemon-reload'); run('systemctl', 'restart', SERVICE)
    restored = verify_backend(old['sourceCommit'], old['sha256'], plan['engine'])
    require(restored['health'].get('rule') == old['health'].get('rule') and restored['health'].get('lives') == old['health'].get('lives'), 'RECOVERY_RULE_DRIFT')
    check_protected(plan, target, plan['preimage']['unit'])
    durable(upload / 'recovery-receipt.json', {'status': 'RECOVERED', 'previousSource': old['sourceCommit'], 'dataPreserved': True})

def apply(upload, plan):
    require(inventory() == plan['preimage'], 'HOST_PREIMAGE_DRIFT')
    require(not get('board')['players'], 'LIVE_PLAYERS_PRESENT')
    require(plan['unitCandidate'] == candidate_unit(plan['preimage']['unit'], plan['preimage']['runtime']['sourceCommit'], plan['sourceCommit']), 'UNIT_SCOPE_DRIFT')
    require(sha(upload / 'payload.tar') == plan['archiveSha256'], 'ARCHIVE_HASH_DRIFT')
    with tarfile.open(upload / 'payload.tar') as archive:
        members = archive.getmembers(); validate_archive(members, plan); files = {m.name: archive.extractfile(m).read() for m in members}
    require(all(digest(data) == plan['files'][name] for name, data in files.items()), 'PAYLOAD_HASH_DRIFT')
    require(all(name in files for name in ['frontend/padel-jump.html', 'frontend/padel-jump-race.html', 'frontend/padel-jump-live.html', 'backend/server.mjs', 'backend/release.json']), 'ENTRY_MISSING')
    for name in ['frontend/release.json', 'backend/release.json']:
        release = json.loads(files[name]); require(release['sourceCommit'] == plan['sourceCommit'] and release['sourceDirty'] is False and release['engine'] == plan['engine'] and release.get('sync') == plan.get('sync') == 'full-game-v1' and release.get('rule') == plan.get('rule') == 'five-lives-stars-v2' and release.get('lives') == plan.get('lives') == 5, 'RELEASE_DRIFT')
    require(json.loads(files['backend/release.json'])['files']['server.mjs']['sha256'] == plan['files']['backend/server.mjs'], 'BACKEND_MANIFEST_DRIFT')
    target = WEB / ('padel-jump-team-' + plan['sourceCommit'][:8]); backend = RELEASES / plan['sourceCommit']
    require(not os.path.lexists(target) and not os.path.lexists(backend), 'TARGET_EXISTS')
    publish_directory(backend, {n.removeprefix('backend/'): d for n, d in files.items() if n.startswith('backend/')})
    check_protected(plan, target, plan['preimage']['unit'], exact_data=True); require(runtime() == plan['preimage']['runtime'] and not get('board')['players'], 'RUNTIME_OR_PLAYERS_DRIFT')
    durable(upload / 'phase-prepared.json', {'phase': 'IMMUTABLE_BACKEND_STAGED', 'sourceCommit': plan['sourceCommit']})
    try:
        write_atomic(UNIT, plan['unitCandidate'].encode(), digest(plan['preimage']['unit'].encode()))
        durable(upload / 'phase-unit.json', {'phase': 'UNIT_UPDATED'})
        run('systemctl', 'daemon-reload'); run('systemctl', 'restart', SERVICE)
        current = verify_backend(plan['sourceCommit'], plan['files']['backend/server.mjs'], plan['engine'])
        require(current['health'].get('sync') == plan['sync'], 'RUNTIME_SYNC_DRIFT')
        require(current['health'].get('rule') == plan['rule'] and current['health'].get('lives') == plan['lives'], 'RUNTIME_RULE_DRIFT')
        publish_directory(target, {n.removeprefix('frontend/'): d for n, d in files.items() if n.startswith('frontend/')})
        check_protected(plan, target, plan['unitCandidate'])
        for name, value in plan['files'].items(): require(sha((target if name.startswith('frontend/') else backend) / name.split('/', 1)[1]) == value, 'INSTALLED_HASH_DRIFT')
        durable(upload / 'receipt.json', {'status': 'PUBLISHED', 'sourceCommit': plan['sourceCommit'], 'runtime': current, 'priorDataPreserved': True, 'nginxAndEnvironmentUnchanged': True, 'url': 'https://padlhub.su/lk/' + target.name + '/padel-jump-race.html'})
    except Exception as error:
        # Rename can succeed even when the following directory fsync fails.
        # A visible new frontend requires the new sync contract: never roll its
        # backend back automatically. Read back the installation before deciding.
        if os.path.lexists(target): raise RuntimeError('FRONTEND_VISIBLE_RECONCILIATION_REQUIRED') from error
        recover(plan, upload); raise

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('mode', choices=['inventory', 'package', 'apply', 'recover']); parser.add_argument('--output', type=Path); parser.add_argument('--preimage', type=Path); parser.add_argument('--ci', type=Path, action='append', default=[]); parser.add_argument('--upload', type=Path); args = parser.parse_args()
    if args.mode == 'package': package(args); return
    require(os.geteuid() == 0 and socket.gethostname() == HOST, 'WRONG_HOST')
    with open('/run/lock/padlhub-jump-live.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == 'inventory': print(json.dumps(inventory(), indent=2)); return
        require(args.upload and re.fullmatch(r'/var/tmp/padlhub-jump-update\.[A-Za-z0-9]{8}', str(args.upload)), 'UPLOAD_PATH_INVALID')
        plan = json.loads((args.upload / 'plan.json').read_text()); require(sha(__file__) == plan['publisherSha256'], 'PUBLISHER_DRIFT')
        if args.mode == 'recover': recover(plan, args.upload)
        else: apply(args.upload, plan)

if __name__ == '__main__': main()
