"""Static-file publication only. All commands hold flock; a durable lease spans upload/smoke.
A missing bootstrap, unknown active bytes or abandoned lease blocks this release.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys

BUNDLES = ['bundle', 'games', 'tournaments', 'tournament-signup', 'group-schedule',
           'padel-day-schedule', 'tournament-subscription', 'tournament-subscription-referral',
           'onboarding', 'levels-info', 'communities']
FONTS = ['rf-dewi-ultrabold', 'rf-dewi-expanded-ultrabold-italic', 'SourceCodePro-Medium', 'SourceCodePro-Regular']
FILES = [x + '.js' for x in BUNDLES] + ['release.json'] + ['fonts/' + x + '.woff2' for x in FONTS]

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def write_json(path, data):
    temp = path.with_suffix('.tmp')
    with open(temp, 'x', encoding='utf8') as handle:
        json.dump(data, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)
    sync_dir(path.parent)

def inventory(path):
    if path.is_symlink() or not path.is_dir():
        raise ValueError('Release directory must be a real directory')
    actual = {str(file.relative_to(path)) for file in path.rglob('*') if file.is_file() or file.is_symlink()}
    if actual != set(FILES):
        raise ValueError('Static namespace contains DEV, academy or unrelated files; owner must isolate it first')
    hashes = {}
    for name in FILES:
        file = path / name
        if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
            raise ValueError('Missing or aliased artifact: ' + name)
        if name.startswith('fonts/') and (path / 'fonts').is_symlink():
            raise ValueError('Aliased fonts directory')
        hashes[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    manifest = json.loads((path / 'release.json').read_text())
    if not re.fullmatch('[a-f0-9]{40}', str(manifest.get('sourceCommit', ''))) or manifest.get('sourceDirty') is not False:
        raise ValueError('Installed source provenance unavailable')
    if not re.fullmatch('[A-Za-z0-9._-]{1,100}', str(manifest.get('version', ''))):
        raise ValueError('Invalid release version')
    return {'source': manifest['sourceCommit'], 'version': manifest['version'], 'hashes': hashes}

def run(request, parent=Path('/var/www/html')):
    # parent injection is for local synthetic tests; CLI never accepts a remote root.
    parent = parent.resolve(strict=True)
    active = parent / 'lk'
    releases = parent / 'lk-frontend-releases'
    if releases.is_symlink() or not releases.is_dir() or not active.is_symlink():
        raise ValueError('Owner bootstrap required: lk symlink and lk-frontend-releases')
    lock = releases / '.lock'
    with open(lock, 'a') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = active.resolve(strict=True)
        if current.parent != releases.resolve() or not re.fullmatch('[a-f0-9]{40}-[a-f0-9]{16}', current.name):
            raise ValueError('Active release is outside the approved static directory')
        state = inventory(current)
        lease_path = releases / '.lease.json'
        op = request['op']
        if op == 'inspect':
            if lease_path.exists():
                raise ValueError('Existing release lease requires owner recovery')
            return state
        token = request.get('token', '')
        if not re.fullmatch('[a-f0-9]{32}', token):
            raise ValueError('Invalid lease token')
        if op == 'acquire':
            if lease_path.exists() or request['previous'] != state:
                raise ValueError('Release lease exists or installed preimage drifted')
            candidate = request['candidate']
            if not re.fullmatch('[a-f0-9]{40}-[a-f0-9]{16}', candidate):
                raise ValueError('Invalid candidate identity')
            destination = releases / candidate
            if destination.exists():
                raise ValueError('Candidate directory already exists')
            lease = {'token': token, 'previousPath': current.name, 'previous': state, 'candidate': candidate, 'phase': 'uploading'}
            write_json(lease_path, lease)
            destination.mkdir()
            sync_dir(releases)
            return {'destination': str(destination)}
        lease = json.loads(lease_path.read_text())
        if lease['token'] != token:
            raise ValueError('Lease ownership mismatch')
        previous = releases / lease['previousPath']
        candidate = releases / lease['candidate']
        if inventory(previous) != lease['previous']:
            raise ValueError('Retained previous release drifted')
        if op == 'publish':
            if current != previous or state != lease['previous'] or lease['phase'] != 'uploading':
                raise ValueError('Installed preimage drifted before publication')
            candidate_state = inventory(candidate)
            if candidate_state != request['expected'] or candidate_state['source'] != candidate.name[:40]:
                raise ValueError('Uploaded artifact mismatch')
            # Freeze the exact candidate BEFORE the switch; interrupted publication is recoverable.
            lease.update({'expected': candidate_state, 'phase': 'publishing'})
            write_json(lease_path, lease)
            for name in FILES:
                with open(candidate / name, 'rb') as handle:
                    os.fsync(handle.fileno())
            sync_dir(candidate / 'fonts')
            sync_dir(candidate)
            target = candidate
        elif op == 'rollback':
            if current == previous and state == lease['previous']:
                return {'restored': True, 'state': state}
            if current != candidate or state != lease.get('expected'):
                raise ValueError('Unknown live state: retain lease, do not overwrite')
            target = previous
        elif op == 'finish':
            expected = lease['previous'] if request.get('rolledBack') else lease.get('expected')
            target = previous if request.get('rolledBack') else candidate
            if current != target or state != expected:
                raise ValueError('Readback drift: retain lease')
            # Receipt before lease removal; unknown/interrupted states stay blocked.
            write_json(releases / (lease['candidate'] + '.receipt.json'), {'source': state['source'], 'state': state, 'rolledBack': request.get('rolledBack', False)})
            lease_path.unlink()
            sync_dir(releases)
            return {'finished': True}
        else:
            raise ValueError('Unknown operation')
        temporary = parent / ('.lk-switch-' + token)
        os.symlink(target, temporary)
        os.replace(temporary, active)
        sync_dir(parent)
        return inventory(active.resolve(strict=True))

if __name__ == '__main__':
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
