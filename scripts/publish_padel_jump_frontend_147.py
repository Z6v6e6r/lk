#!/usr/bin/env python3
"""Immutable frontend-only Jump update; never restarts backend or changes nginx."""
import argparse
import ctypes
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tarfile
import tempfile
import urllib.request

HOST = '3170594-cd19972'
WEB = Path('/var/www/html/lk')

def require(ok, message):
    if not ok: raise RuntimeError(message)

def digest(data): return hashlib.sha256(data).hexdigest()
def sha(path): return digest(Path(path).read_bytes())
def run(*args): return subprocess.check_output(args, text=True).strip()

def snapshot(ignore=None):
    require(os.geteuid() == 0 and socket.gethostname() == HOST, 'WRONG_HOST')
    require(run('systemctl', 'is-active', 'padlhub-jump-live.service') == 'active', 'BACKEND_NOT_ACTIVE')
    pid = run('systemctl', 'show', '-p', 'MainPID', '--value', 'padlhub-jump-live.service')
    args = Path('/proc/' + pid + '/cmdline').read_bytes().split(b'\0')
    backend = args[1].decode(); match = re.fullmatch(r'/opt/padlhub-jump-live/releases/([a-f0-9]{40})/server.mjs', backend)
    require(match, 'BACKEND_SOURCE_UNKNOWN')
    with urllib.request.urlopen('http://127.0.0.1:5193/jump-live-api/health', timeout=5) as response: health = json.load(response)
    roots = [Path('/etc/nginx/sites-enabled'), Path('/etc/nginx/snippets'), Path('/etc/nginx/phab-traffic')]
    roots += sorted(p for p in WEB.glob('padel-jump-*') if p.is_dir() and p != ignore)
    protected = {}
    for root in roots:
        for path in sorted(root.rglob('*')):
            if path.is_file(): protected[str(path)] = {'sha256': sha(path), 'realpath': str(path.resolve())}
    for root in [WEB, Path('/var/www/html/lk-frontend-current')]:
        for path in root.iterdir():
            if path.is_file(): protected[str(path)] = {'sha256': sha(path), 'realpath': str(path.resolve())}
    for path in ['/etc/systemd/system/padlhub-jump-live.service', '/etc/padlhub-jump-live.env']:
        protected[path] = {'sha256': sha(path), 'realpath': str(Path(path).resolve())}
    return {'host': HOST, 'protected': protected, 'lkPointer': str(Path('/var/www/html/lk-frontend-current').resolve()),
            'backend': {'pid': int(pid), 'sourceCommit': match[1], 'sha256': sha(backend), 'engine': health['engine'], 'rule': health['rule'], 'lives': health.get('lives'), 'sync': health.get('sync')}}

def public_file(relative, data):
    if relative == 'manifest.json':
        require(data == Path('public/manifest.json').read_bytes(), 'PUBLIC_MANIFEST_DRIFT'); return False
    require(Path(relative).suffix in ['.html', '.js', '.css', '.svg', '.webp', '.png', '.ico'], 'UNEXPECTED_PUBLIC_FILE')
    return True

def package(args):
    require(args.output and args.ci and args.preimage, 'PACKAGE_INPUTS_REQUIRED')
    git = lambda *v: run('git', *v)
    require(not git('status', '--porcelain'), 'DIRTY_SOURCE')
    source = git('rev-parse', 'HEAD'); branch = git('branch', '--show-current')
    require(branch.startswith('codex/') and git('rev-parse', 'origin/' + branch) == source, 'UNPUSHED_SOURCE')
    ci = json.loads(args.ci.read_text()); require(ci['headSha'] == source and ci['status'] == 'completed' and ci['conclusion'] == 'success', 'CI_NOT_GREEN')
    before = json.loads(args.preimage.read_text())
    contract = Path('src/components/padel-jump/live-contract.ts').read_text()
    engine = re.search(r"LIVE_ENGINE_VERSION = '([a-f0-9]{64})'", contract)[1]
    require(engine == before['backend']['engine'], 'BACKEND_ENGINE_INCOMPATIBLE')
    sync = re.search(r"LIVE_SYNC = '([a-z0-9-]+)'", contract)[1]
    require(sync == before['backend'].get('sync'), 'BACKEND_SYNC_INCOMPATIBLE')
    rule = re.search(r"LIVE_RULE = '([a-z0-9-]+)'", contract)[1]
    lives = int(re.search(r"LIVE_LIVES = ([0-9]+)", contract)[1])
    require(rule == before['backend'].get('rule') and lives == before['backend'].get('lives'), 'BACKEND_RULE_INCOMPATIBLE')
    subprocess.run(['npx', 'vite', 'build', '--config', 'games/padel-jump/vite.config.ts'], check=True)
    require(not git('status', '--porcelain') and git('rev-parse', 'HEAD') == source, 'SOURCE_BUILD_DRIFT')
    args.output.mkdir(mode=0o700); files = {}
    for path in Path('dist/padel-jump').rglob('*'):
        require(not path.is_symlink(), 'STATIC_SYMLINK')
        if not path.is_file(): continue
        name = str(path.relative_to('dist/padel-jump')); data = path.read_bytes()
        if public_file(name, data): files[name] = data
    release = {'schema': 'PADLHUB_JUMP_FRONTEND_V1', 'sourceCommit': source, 'sourceDirty': False, 'engine': engine, 'rule': rule, 'lives': lives, 'sync': sync, 'backendSourceCommit': before['backend']['sourceCommit'], 'ciRun': ci['url'], 'files': {name: {'sha256': digest(data), 'size': len(data)} for name, data in files.items()}}
    files['release.json'] = (json.dumps(release, indent=2) + '\n').encode()
    with tarfile.open(args.output / 'payload.tar', 'w') as tar:
        for name, data in sorted(files.items()):
            entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o644; tar.addfile(entry, io.BytesIO(data))
    publisher = Path(__file__).read_bytes(); (args.output / 'publisher.py').write_bytes(publisher)
    plan = {'sourceCommit': source, 'preimage': before, 'engine': engine, 'rule': rule, 'lives': lives, 'sync': sync, 'publisherSha256': digest(publisher), 'archiveSha256': sha(args.output / 'payload.tar'), 'files': {name: digest(data) for name, data in files.items()}}
    (args.output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n'); (args.output / 'release.json').write_bytes(files['release.json'])
    print(json.dumps({'sourceCommit': source, 'files': len(files), 'archiveSha256': plan['archiveSha256']}))

def validate_archive(members, plan):
    require(len(members) == len(plan['files']) <= 150 and {m.name for m in members} == set(plan['files']), 'ARCHIVE_SET_DRIFT')
    require(sum(m.size for m in members) <= 50 * 1024 * 1024, 'ARCHIVE_SIZE_LIMIT')
    for member in members:
        path = Path(member.name)
        require(member.isfile() and not path.is_absolute() and '..' not in path.parts and member.name == str(path), 'UNSAFE_ARCHIVE')
        require(path.suffix in ['.html', '.js', '.css', '.svg', '.webp', '.png', '.ico'] or member.name == 'release.json', 'UNEXPECTED_PUBLIC_FILE')

def apply(upload):
    plan = json.loads((upload / 'plan.json').read_text()); require(sha(__file__) == plan['publisherSha256'], 'PUBLISHER_DRIFT')
    require(re.fullmatch(r'[a-f0-9]{40}', plan['sourceCommit']), 'SOURCE_INVALID')
    require(snapshot() == plan['preimage'], 'HOST_PREIMAGE_DRIFT')
    require(sha(upload / 'payload.tar') == plan['archiveSha256'], 'ARCHIVE_HASH_DRIFT')
    target = WEB / ('padel-jump-team-' + plan['sourceCommit'][:8]); require(not os.path.lexists(target), 'TARGET_EXISTS')
    require(WEB.resolve() == WEB, 'WEBROOT_SYMLINK')
    temporary = upload / 'unpacked'; temporary.mkdir(mode=0o700)
    with tarfile.open(upload / 'payload.tar') as tar:
        members = tar.getmembers(); validate_archive(members, plan)
        for member in members: tar.extract(member, temporary)
    for name, value in plan['files'].items(): require(sha(temporary / name) == value, 'FILE_HASH_DRIFT')
    release = json.loads((temporary / 'release.json').read_text())
    require(release['sourceCommit'] == plan['sourceCommit'] and release['sourceDirty'] is False and release['engine'] == plan['engine'] == plan['preimage']['backend']['engine'], 'RELEASE_INCOMPATIBLE')
    require(release['backendSourceCommit'] == plan['preimage']['backend']['sourceCommit'], 'BACKEND_SOURCE_DRIFT')
    require(release.get('sync') == plan.get('sync') == plan['preimage']['backend'].get('sync') and isinstance(plan.get('sync'), str), 'BACKEND_SYNC_INCOMPATIBLE')
    require(release.get('rule') == plan.get('rule') == plan['preimage']['backend'].get('rule') and release.get('lives') == plan.get('lives') == plan['preimage']['backend'].get('lives') and isinstance(plan.get('rule'), str) and isinstance(plan.get('lives'), int), 'BACKEND_RULE_INCOMPATIBLE')
    require(all(name in plan['files'] for name in ['padel-jump.html', 'padel-jump-race.html', 'padel-jump-live.html']), 'ENTRY_MISSING')
    stage = Path(tempfile.mkdtemp(prefix='.jump-frontend-', dir=WEB))
    for name in plan['files']:
        path = stage / name; path.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(temporary / name, path)
        with path.open('rb') as f: os.fsync(f.fileno())
        path.chmod(0o644)
    for path in stage.rglob('*'):
        if path.is_dir(): path.chmod(0o755)
    stage.chmod(0o755)
    for directory in sorted([stage, *[p for p in stage.rglob('*') if p.is_dir()]], key=lambda p: len(p.parts), reverse=True):
        fd = os.open(directory, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    require(snapshot() == plan['preimage'], 'HOST_PREIMAGE_DRIFT')
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.renameat2(-100, os.fsencode(stage), -100, os.fsencode(target), 1) == 0, 'NO_CLOBBER_PUBLICATION_FAILED')
    fd = os.open(WEB, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
    require(snapshot(ignore=target) == plan['preimage'], 'PROTECTED_OR_BACKEND_DRIFT')
    for name, value in plan['files'].items(): require(sha(target / name) == value, 'PUBLISHED_HASH_DRIFT')
    receipt = {'status': 'PUBLISHED', 'sourceCommit': plan['sourceCommit'], 'engine': plan['engine'], 'backendUnchanged': True, 'nginxUnchanged': True, 'protectedPaths': len(plan['preimage']['protected']), 'url': 'https://padlhub.su/lk/' + target.name + '/padel-jump-race.html'}
    with (upload / 'receipt.json').open('x') as f: json.dump(receipt, f, indent=2); f.flush(); os.fsync(f.fileno())
    fd = os.open(upload, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
    print(json.dumps(receipt, indent=2))

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('mode', choices=['inventory', 'package', 'apply']); parser.add_argument('--upload', type=Path); parser.add_argument('--output', type=Path); parser.add_argument('--ci', type=Path); parser.add_argument('--preimage', type=Path)
    args = parser.parse_args()
    if args.mode == 'package': package(args); return
    require(os.geteuid() == 0 and socket.gethostname() == HOST, 'WRONG_HOST')
    with open('/run/lock/padlhub-jump-live.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == 'inventory': print(json.dumps(snapshot(), indent=2)); return
        require(args.upload and re.fullmatch(r'/var/tmp/padlhub-jump-frontend\.[A-Za-z0-9]{8}', str(args.upload)), 'UPLOAD_PATH_INVALID'); apply(args.upload)

if __name__ == '__main__': main()
