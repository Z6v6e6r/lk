#!/usr/bin/env python3
"""Build a private immutable activation packet from clean pushed, green-CI source."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def include_public_artifact(relative, data):
    # Vite copies the cabinet PWA manifest from public/. This standalone game
    # does not reference it; omit only the exact known source bytes.
    if relative == 'manifest.json':
        if data != Path('public/manifest.json').read_bytes(): raise RuntimeError('Copied public manifest drift')
        return False
    if Path(relative).suffix not in ['.html', '.css', '.js', '.svg', '.webp', '.png', '.ico']: raise RuntimeError('Unexpected public artifact: ' + relative)
    return True

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--preimage', required=True, type=Path)
    parser.add_argument('--nginx-preimage', required=True, type=Path)
    parser.add_argument('--community', required=True, type=Path)
    parser.add_argument('--ci', required=True, type=Path)
    args = parser.parse_args()
    if git('status', '--porcelain'): raise RuntimeError('Clean source checkout required')
    source = git('rev-parse', 'HEAD'); branch = git('branch', '--show-current')
    if not branch.startswith('codex/') or git('rev-parse', 'origin/' + branch) != source: raise RuntimeError('Pushed task-branch source required')
    ci = json.loads(args.ci.read_text())
    if ci.get('headSha') != source or ci.get('conclusion') != 'success' or ci.get('status') != 'completed': raise RuntimeError('Exact-head successful CI required')
    community = json.loads(args.community.read_text())
    if not re.fullmatch(r'[\w-]{1,120}', community['id']): raise RuntimeError('Invalid community ID')
    preimage = json.loads(args.preimage.read_text()); nginx = args.nginx_preimage.read_bytes()
    if digest(nginx) != preimage['nginx']: raise RuntimeError('Nginx preimage mismatch')
    args.output.mkdir(mode=0o700)
    # Build both artifacts here, after pinning clean pushed source and successful
    # CI; never assign current provenance to an arbitrary pre-existing dist/.
    subprocess.run(['npm', 'run', 'build:jump-live'], check=True)
    subprocess.run(['npx', 'vite', 'build', '--config', 'games/padel-jump/vite.config.ts'], check=True)
    if git('status', '--porcelain') or git('rev-parse', 'HEAD') != source: raise RuntimeError('Source changed during release build')
    payload = {}
    for path in Path('dist/padel-jump').rglob('*'):
        if path.is_symlink(): raise RuntimeError('Symlink in static build')
        if not path.is_file(): continue
        relative = str(path.relative_to('dist/padel-jump')); data = path.read_bytes()
        if not include_public_artifact(relative, data): continue
        payload['frontend/' + relative] = data
    backend = json.loads(Path('dist/padel-jump-live/release.json').read_text())
    if backend['sourceCommit'] != source or backend['sourceDirty'] is not False: raise RuntimeError('Backend build provenance mismatch')
    for name in ['server.mjs', 'release.json']: payload['backend/' + name] = Path('dist/padel-jump-live', name).read_bytes()
    if digest(payload['backend/server.mjs']) != backend['files']['server.mjs']['sha256']: raise RuntimeError('Backend build hash mismatch')
    frontend = {'schema': 'PADLHUB_JUMP_TEAM_STATIC_V1', 'sourceCommit': source, 'sourceDirty': False, 'engine': backend['engine'], 'ciRun': ci.get('url'),
                'files': {name.removeprefix('frontend/'): {'sha256': digest(data), 'size': len(data)} for name, data in payload.items() if name.startswith('frontend/')}}
    payload['frontend/release.json'] = (json.dumps(frontend, indent=2) + '\n').encode()
    community_hash = digest(community['id'].encode())[:16]
    payload['ops/unit.service'] = Path('games/padel-jump/live/deploy/unit.service.in').read_bytes().replace(b'@SOURCE@', source.encode()).replace(b'@COMMUNITY_HASH@', community_hash.encode())
    payload['ops/api.conf'] = Path('games/padel-jump/live/deploy/api.nginx.conf').read_bytes()
    payload['ops/env.conf'] = ('JUMP_PUBLIC_ORIGIN=https://padlhub.su\nJUMP_COMMUNITY_ID=' + community['id'] + '\nJUMP_PORT=5193\nJUMP_RESULTS_DIR=/var/lib/padlhub-jump-live/' + community_hash + '\n').encode()
    anchor = b'    include /etc/nginx/snippets/padlhub-padel-mix.conf;\n'
    marker = b'    include /etc/nginx/snippets/padlhub-jump-live.conf;\n'
    if nginx.count(anchor) != 1 or marker in nginx: raise RuntimeError('Unexpected nginx include topology')
    payload['ops/nginx.candidate.conf'] = nginx.replace(anchor, anchor + marker)
    with tarfile.open(args.output / 'payload.tar', 'w') as archive:
        for name, data in sorted(payload.items()):
            entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o600; archive.addfile(entry, io.BytesIO(data))
    publisher = Path('scripts/padel_jump_live_147.py').read_bytes()
    (args.output / 'publisher.py').write_bytes(publisher)
    plan = {'schema': 'PADLHUB_JUMP_COMMUNITY_147_V1', 'sourceCommit': source, 'engine': backend['engine'], 'communityId': community['id'],
            'ciRun': ci.get('url'), 'preimage': preimage, 'archiveSha256': digest((args.output / 'payload.tar').read_bytes()), 'publisherSha256': digest(publisher),
            'files': {name: digest(data) for name, data in payload.items()}}
    (args.output / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    # Review copies remain private and are never part of the public web directory.
    for name in ['unit.service', 'api.conf', 'env.conf', 'nginx.candidate.conf']: (args.output / name).write_bytes(payload['ops/' + name])
    (args.output / 'frontend-release.json').write_bytes(payload['frontend/release.json'])
    print(json.dumps({'sourceCommit': source, 'files': len(payload), 'archiveSha256': plan['archiveSha256'], 'output': str(args.output)}, indent=2))

if __name__ == '__main__': main()
