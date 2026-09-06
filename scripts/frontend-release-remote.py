"""Static-file publication only. All commands hold flock; a durable lease spans upload/smoke.
A missing bootstrap, unknown active bytes or abandoned lease blocks this release.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import stat

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
    public_link = parent / 'lk-frontend-current'
    releases = parent / 'lk-frontend-releases'
    active = releases / 'current'
    if not public_link.is_symlink() or os.readlink(public_link) != 'lk-frontend-releases/current':
        raise ValueError('Owner bootstrap required: immutable public link to release-store current')
    if releases.is_symlink() or not releases.is_dir() or not active.is_symlink():
        raise ValueError('Owner bootstrap required: lk-frontend-current symlink and lk-frontend-releases')
    lock = releases / '.lock'
    with open(lock, 'a') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not re.fullmatch('[a-f0-9]{40}-[a-f0-9]{16}', os.readlink(active)):
            raise ValueError('Current symlink must name one retained release')
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
        if op == 'upload':
            if lease['phase'] != 'uploading' or current != previous or state != lease['previous']:
                raise ValueError('Upload requires the active uploading lease')
            if request.get('candidate') != lease['candidate'] or request.get('name') not in FILES:
                raise ValueError('Upload outside leased standard artifact namespace')
            if candidate.is_symlink() or not candidate.is_dir():
                raise ValueError('Aliased or missing candidate directory')
            size = request.get('size')
            if type(size) is not int or not 0 < size <= MAX_ARTIFACT_BYTES:
                raise ValueError('Invalid artifact size')
            data = base64.b64decode(request['data'], validate=True)
            if len(data) != size or hashlib.sha256(data).hexdigest() != request.get('sha256'):
                raise ValueError('Upload size or hash mismatch')
            fonts = candidate / 'fonts'
            if request['name'].startswith('fonts/'):
                if not fonts.exists() and not fonts.is_symlink():
                    fonts.mkdir(mode=0o755)
                if fonts.is_symlink() or not fonts.is_dir():
                    raise ValueError('Aliased fonts directory')
            destination = candidate / request['name']
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            sync_dir(destination.parent)
            return {'uploaded': request['name'], 'sha256': request['sha256']}
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
        temporary = releases / ('.switch-' + token)
        os.symlink(target.name, temporary)
        os.replace(temporary, active)
        sync_dir(releases)
        return inventory(active.resolve(strict=True))

# SSH never runs caller-supplied code. The owner installs this exact file outside the
# writable release store and pins its hash; sshd ForceCommand invokes Python -I -B.
MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
MAX_REQUEST_BYTES = ((MAX_ARTIFACT_BYTES + 2) // 3) * 4 + 65536

def dispatch(command, raw, code_hash, parent=Path('/var/www/html')):
    if command != 'lk-frontend-v1 ' + code_hash:
        raise ValueError('SSH command is not the pinned static protocol')
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError('Request too large')
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get('op') not in ['inspect', 'acquire', 'upload', 'publish', 'rollback', 'finish']:
        raise ValueError('Unknown static operation')
    return run(request, parent)

def trusted_installed_code(file):
    # Reject a helper or any containing directory writable by the deploy identity.
    for entry in [file, *file.parents]:
        metadata = entry.lstat()
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError('Helper installation must be root-owned and immutable to deploy user')
    return hashlib.sha256(file.read_bytes()).hexdigest()

if __name__ == '__main__':
    try:
        code_hash = trusted_installed_code(Path(__file__).absolute())
        command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
        if command != 'lk-frontend-v1 ' + code_hash:
            raise ValueError('SSH command is not the pinned static protocol')
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        print(json.dumps(dispatch(command, raw, code_hash)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
