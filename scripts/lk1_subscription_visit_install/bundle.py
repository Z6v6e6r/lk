#!/usr/bin/env python3
"""Build an immutable stopped-install bundle from an approved DEV packet."""
from __future__ import print_function
import argparse, hashlib, json, os, shutil, stat, subprocess, tarfile, tempfile
from pathlib import Path
from install import (HOST, TARGETS, NODE_ARCHIVE_SHA256, canonical, relative_inventory, require, sha256)

ROOT = Path(__file__).resolve().parents[2]

def copy_file(source, destination, mode=0o640):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(str(source), str(destination))
    os.chmod(str(destination), mode)

def verify_closure(dependencies, inventory_file, audit_file):
    closure = json.loads(Path(inventory_file).read_text())
    require(closure.get('files') == [{**row} for row in closure.get('files', [])], 'INSTALL_CLOSURE_FORMAT')
    current = []
    root = Path(dependencies)
    for item in sorted(root.rglob('*')):
        if item.is_symlink(): current.append({'path': item.relative_to(root).as_posix(), 'type': 'symlink', 'link': os.readlink(str(item))})
        elif item.is_file(): current.append({'path': item.relative_to(root).as_posix(), 'type': 'file', 'sha256': sha256(item)})
    require(current == closure['files'], 'INSTALL_CLOSURE_DRIFT')
    audit_bytes = Path(audit_file).read_bytes(); audit = json.loads(audit_bytes)
    require(audit.get('metadata', {}).get('vulnerabilities', {}).get('total') == 0, 'INSTALL_AUDIT_NOT_ZERO')
    return sha256(inventory_file), sha256(audit_file)

def verify_runtime_packet(packet, packet_sha):
    manifest_path = packet / 'manifest.json'
    require(sha256(manifest_path) == packet_sha, 'INSTALL_RUNTIME_MANIFEST_SHA256')
    manifest = json.loads(manifest_path.read_text())
    require(manifest.get('formatVersion') == 1 and manifest.get('environment') == 'DEV'
            and manifest.get('purpose') == 'SYNTHETIC_PAID_JOIN_REHEARSAL'
            and manifest.get('sourceDirty') is False and manifest.get('productionCompatible') is False
            and manifest.get('installAuthorized') is False and manifest.get('startAuthorized') is False,
            'INSTALL_RUNTIME_MANIFEST')
    rows = manifest.get('files')
    require(isinstance(rows, list) and rows, 'INSTALL_RUNTIME_FILES')
    declared = set()
    for row in rows:
        name = row.get('path') if isinstance(row, dict) else None
        require(isinstance(name, str) and name and not name.startswith('/') and '..' not in Path(name).parts,
                'INSTALL_RUNTIME_PATH')
        require(name not in declared and isinstance(row.get('sha256'), str), 'INSTALL_RUNTIME_DUPLICATE')
        declared.add(name)
        file = packet / name
        require(file.is_file() and not file.is_symlink() and sha256(file) == row['sha256'], 'INSTALL_RUNTIME_DRIFT:' + name)
    require({item.relative_to(packet).as_posix() for item in packet.rglob('*') if item.is_file()} == declared | {'manifest.json'},
            'INSTALL_RUNTIME_EXTRA_FILE')
    return manifest

def build(packet, packet_sha, dependencies, inventory_file, audit_file, node_archive, output):
    require(subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain'], text=True) == '', 'INSTALL_SOURCE_DIRTY')
    output = Path(output).absolute(); parent = output.parent.resolve()
    require(str(parent).startswith('/tmp/') or str(parent).startswith('/private/tmp/'), 'INSTALL_OUTPUT_PRIVATE_TMP')
    require(not output.exists() and output.name and '/' not in output.name, 'INSTALL_OUTPUT_EXISTS')
    packet = Path(packet).resolve(); manifest = verify_runtime_packet(packet, packet_sha)
    require(sha256(node_archive) == NODE_ARCHIVE_SHA256, 'INSTALL_NODE_ARCHIVE_SHA256')
    closure_sha, audit_sha = verify_closure(dependencies, inventory_file, audit_file)
    stage = Path(tempfile.mkdtemp(prefix='.visit-stopped-install-', dir=str(parent)))
    try:
        payload = stage / 'payload'; visit = payload / 'visit-packet'
        shutil.copytree(str(packet), str(visit), symlinks=True)
        shutil.copytree(str(Path(dependencies) / 'node_modules'), str(visit / 'node_modules'), symlinks=True)
        node = payload / 'node22/bin/node'; node.parent.mkdir(parents=True)
        member = 'node-v22.23.2-linux-x64/bin/node'
        with tarfile.open(str(node_archive), 'r:xz') as archive:
            info = archive.getmember(member); source = archive.extractfile(info); require(source is not None, 'INSTALL_NODE_ARCHIVE_MEMBER')
            with open(str(node), 'wb') as target: shutil.copyfileobj(source, target)
        node_bytes = node.read_bytes()
        require(node_bytes[:20].startswith(b'\x7fELF') and node_bytes[18:20] == b'\x3e\x00', 'INSTALL_NODE_BINARY_ARCH')
        os.chmod(str(node), 0o750)
        copy_file(ROOT / 'scripts/lk1_subscription_visit_dev/units/lk1-subscription-visit-dev.service', payload / 'visit-unit.service')
        dropin = payload / 'mongo-dropin'; dropin.mkdir(); copy_file(ROOT / 'scripts/lk1_subscription_visit_dev/units/mongo-private-network.conf', dropin / '50-private-network.conf')
        runtime_hash = sha256(visit / 'manifest.json')
        (payload / 'visit-service.env').write_text('VISIT_MANIFEST_SHA256=' + runtime_hash + '\n')
        os.chmod(str(payload / 'visit-service.env'), 0o640)
        copy_file(Path(__file__).with_name('install.py'), stage / 'install.py', 0o750)
        for item in payload.rglob('*'):
            if not item.is_symlink(): os.chmod(str(item), 0o750 if item.is_dir() or os.stat(str(item)).st_mode & 0o111 else 0o640)
        source_commit = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
        bundle = {'format':'LK_VISIT_STOPPED_INSTALL_V1','environment':'DEV','targetHost':HOST,'sourceCommit':source_commit,
                  'sourceDirty':False,'productionCompatible':False,'installAuthorized':False,'startAuthorized':False,
                  'runtimeManifestSha256':runtime_hash,'nodeArchiveSha256':NODE_ARCHIVE_SHA256,'nodeBinarySha256':sha256(node),
                  'dependencyInventorySha256':closure_sha,'auditSha256':audit_sha,'targets':[list(row) for row in TARGETS],
                  'installerSha256':sha256(stage / 'install.py'),'payloadInventory':relative_inventory(payload)}
        (stage / 'manifest.json').write_text(canonical(bundle)); os.chmod(str(stage / 'manifest.json'), 0o640)
        os.rename(str(stage), str(output))
    except Exception:
        shutil.rmtree(str(stage), ignore_errors=True); raise
    return {'bundle':str(output),'manifestSha256':sha256(output / 'manifest.json')}

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--packet',required=True); parser.add_argument('--packet-sha',required=True); parser.add_argument('--dependencies',required=True); parser.add_argument('--dependency-inventory',required=True); parser.add_argument('--audit-file',required=True); parser.add_argument('--node-archive',required=True); parser.add_argument('--output',required=True)
    print(json.dumps(build(parser.parse_args().packet,parser.parse_args().packet_sha,parser.parse_args().dependencies,parser.parse_args().dependency_inventory,parser.parse_args().audit_file,parser.parse_args().node_archive,parser.parse_args().output),sort_keys=True))
