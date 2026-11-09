#!/usr/bin/env python3
"""Build a private immutable activation packet from clean pushed, green-CI source."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import tarfile

instance_config = runpy.run_path(str(Path(__file__).with_name('padel_jump_live_147.py')))['instance_config']


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

def event_binding(community):
    code = """
import fs from 'node:fs';
import { parseEventBinding } from './games/padel-jump/live/event-binding.mjs';
import { parseEventRegistrationPolicy, eventRetentionUntil } from './src/services/community-policy.ts';
try {
  const value = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (value.communityType !== 'EVENT' || value.archived === true || !value.typeSettings?.gameIds?.includes('padel-jump')) throw new Error();
  const policy = parseEventRegistrationPolicy(value.typeSettings.registrationPolicy);
  process.stdout.write(JSON.stringify(parseEventBinding({ epoch: value.typeSettingsEffectiveAt, policyRevision: value.typeSettingsRevision, startsAt: policy.startsAt, endsAt: policy.endsAt, retentionUntil: eventRetentionUntil(policy.endsAt), inviteCode: value.inviteCode })));
} catch { process.exitCode = 1; }
"""
    result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', code], input=json.dumps(community), text=True, capture_output=True, timeout=10)
    if result.returncode: raise RuntimeError('EVENT_BINDING_INVALID')
    return json.loads(result.stdout)

def render_ops(config, source, community_id, event, nginx):
    if config != instance_config(config.get('name')): raise RuntimeError('INSTANCE_TARGET_MISMATCH')
    if not re.fullmatch(r'[a-f0-9]{40}', source) or not re.fullmatch(r'[\w-]{1,120}', community_id): raise RuntimeError('PLAN_ID_INVALID')
    if config['name'] == 'exhibition' and not event: raise RuntimeError('EVENT_BINDING_REQUIRED')
    community_hash = digest(community_id.encode())[:16]
    unit = Path('games/padel-jump/live/deploy/unit.service.in').read_bytes().replace(b'@SOURCE@', source.encode()).replace(b'@COMMUNITY_HASH@', community_hash.encode())
    api = Path('games/padel-jump/live/deploy/api.nginx.conf').read_bytes()
    if config['name'] == 'exhibition':
        unit = unit.replace(b'padlhub-jump-live', config['account'].encode())
        api = api.replace(b'/jump-live-api/', config['api'].encode()).replace(b'127.0.0.1:5193', b'127.0.0.1:5194')
    env = 'JUMP_PUBLIC_ORIGIN=https://padlhub.su\nJUMP_COMMUNITY_ID=' + community_id + '\nJUMP_PORT=' + str(config['port']) + '\nJUMP_RESULTS_DIR=' + config['dataRoot'] + '/' + community_hash + '\n'
    if event:
        if config['name'] != 'exhibition' or "'" in json.dumps(event): raise RuntimeError('EVENT_BINDING_INVALID')
        env += "JUMP_EVENT_BINDING='" + json.dumps(event, ensure_ascii=False, separators=(',', ':')) + "'\n"
    anchor = b'    include /etc/nginx/snippets/padlhub-padel-mix.conf;\n'
    marker = ('    include ' + config['snippet'] + ';\n').encode()
    team_marker = b'    include /etc/nginx/snippets/padlhub-jump-live.conf;\n'
    if nginx.count(anchor) != 1 or marker in nginx or config['name'] == 'exhibition' and nginx.count(team_marker) != 1: raise RuntimeError('Unexpected nginx include topology')
    return {'ops/unit.service': unit, 'ops/api.conf': api, 'ops/env.conf': env.encode(), 'ops/nginx.candidate.conf': nginx.replace(anchor, anchor + marker)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--preimage', required=True, type=Path)
    parser.add_argument('--nginx-preimage', required=True, type=Path)
    parser.add_argument('--community', required=True, type=Path)
    parser.add_argument('--ci', required=True, type=Path)
    parser.add_argument('--instance', choices=['team', 'exhibition'], default='team')
    args = parser.parse_args()
    os.umask(0o077)
    config = instance_config(args.instance)
    if git('status', '--porcelain'): raise RuntimeError('Clean source checkout required')
    source = git('rev-parse', 'HEAD'); branch = git('branch', '--show-current')
    if not branch.startswith(('codex/', 'agent/')) or git('rev-parse', 'origin/' + branch) != source: raise RuntimeError('Pushed task-branch source required')
    ci = json.loads(args.ci.read_text())
    if ci.get('headSha') != source or ci.get('conclusion') != 'success' or ci.get('status') != 'completed': raise RuntimeError('Exact-head successful CI required')
    community = json.loads(args.community.read_text())
    if not re.fullmatch(r'[\w-]{1,120}', community['id']): raise RuntimeError('Invalid community ID')
    event = event_binding(community) if args.instance == 'exhibition' else None
    preimage = json.loads(args.preimage.read_text()); nginx = args.nginx_preimage.read_bytes()
    if digest(nginx) != preimage['nginx']: raise RuntimeError('Nginx preimage mismatch')
    if args.instance == 'exhibition':
        if preimage.get('instance') != 'exhibition' or not preimage.get('teamRuntime'): raise RuntimeError('Exhibition preimage must protect the team runtime')
        repo = Path(git('rev-parse', '--show-toplevel'))
        if not args.output.is_absolute() or args.output.parent.resolve() != args.output.parent or args.output.is_relative_to(repo) or args.output.parent.stat().st_mode & 0o777 != 0o700: raise RuntimeError('Private external output parent required')
        subprocess.run(['node', 'scripts/assert-build-env.mjs', 'production'], check=True)
    ops = render_ops(config, source, community['id'], event, nginx)
    args.output.mkdir(mode=0o700)
    # Build both artifacts here, after pinning clean pushed source and successful
    # CI; never assign current provenance to an arbitrary pre-existing dist/.
    subprocess.run(['npm', 'run', 'build:jump-live', *(['--', '--instance', 'exhibition'] if event else [])], check=True)
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
    if event and (backend.get('instance') != 'exhibition' or backend.get('resultStoragePolicy') != 'event-retention-v1' or backend.get('admissionContract') != 'canonical-event-v1'): raise RuntimeError('Exhibition backend contract mismatch')
    frontend = {'schema': 'PADLHUB_JUMP_EXHIBITION_STATIC_V1' if event else 'PADLHUB_JUMP_TEAM_STATIC_V1', 'instance': args.instance, 'sourceCommit': source, 'sourceDirty': False, 'engine': backend['engine'], 'ciRun': ci.get('url'),
                'sync': backend['sync'], 'rule': backend['rule'], 'lives': backend['lives'], 'resultStoragePolicy': backend['resultStoragePolicy'], 'admissionContract': 'canonical-event-v1' if event else 'companion-v1',
                'files': {name.removeprefix('frontend/'): {'sha256': digest(data), 'size': len(data)} for name, data in payload.items() if name.startswith('frontend/')}}
    payload['frontend/release.json'] = (json.dumps(frontend, indent=2) + '\n').encode()
    payload.update(ops)
    with tarfile.open(args.output / 'payload.tar', 'w') as archive:
        for name, data in sorted(payload.items()):
            entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o600; archive.addfile(entry, io.BytesIO(data))
    publisher = Path('scripts/padel_jump_live_147.py').read_bytes()
    (args.output / 'publisher.py').write_bytes(publisher)
    plan = {'schema': 'PADLHUB_JUMP_EXHIBITION_147_V1' if event else 'PADLHUB_JUMP_COMMUNITY_147_V1', 'instance': args.instance, 'target': config, 'sourceCommit': source, 'engine': backend['engine'], 'communityId': community['id'],
            'sync': backend['sync'], 'rule': backend['rule'], 'lives': backend['lives'], 'resultStoragePolicy': backend['resultStoragePolicy'], 'admissionContract': frontend['admissionContract'],
            **({'eventBinding': event, 'communityConfigSha256': digest(args.community.read_bytes())} if event else {}),
            'ciRun': ci.get('url'), 'preimage': preimage, 'archiveSha256': digest((args.output / 'payload.tar').read_bytes()), 'publisherSha256': digest(publisher),
            'files': {name: digest(data) for name, data in payload.items()}}
    (args.output / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    # Review copies remain private and are never part of the public web directory.
    for name in ['unit.service', 'api.conf', 'env.conf', 'nginx.candidate.conf']: (args.output / name).write_bytes(payload['ops/' + name])
    (args.output / 'frontend-release.json').write_bytes(payload['frontend/release.json'])
    print(json.dumps({'sourceCommit': source, 'files': len(payload), 'archiveSha256': plan['archiveSha256'], 'output': str(args.output)}, indent=2))

if __name__ == '__main__': main()
