#!/usr/bin/env python3
"""Private exhibition score receipts only; canonical forms/exports/backups are separate scopes."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import pwd
import socket
import stat
import subprocess
import sys
from datetime import datetime, timezone
import uuid
from typing import NoReturn

UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
FILE = re.compile(r'(?:' + UUID + r'\.json|\.pending-' + UUID + r')')
MAX_FILES = 100000


def fail(reason) -> NoReturn:
    raise RuntimeError(reason)


def execution_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def iso(value):
    try:
        return isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value) is not None and datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat(timespec='milliseconds').replace('+00:00', 'Z') == value
    except (ValueError, TypeError):
        return False


def selector(community, actor, expired, now, reconcile=False):
    if not isinstance(community, str) or not re.fullmatch(r'[\w-]{1,120}', community) or not iso(now): fail('ERASURE_SCOPE_INVALID')
    if type(expired) is not bool or type(reconcile) is not bool or sum([bool(actor), expired, reconcile]) != 1 or reconcile and actor is not None or actor and (not isinstance(actor, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', actor)): fail('ERASURE_SCOPE_INVALID')


def root_fd(directory):
    root = Path(directory)
    if not root.is_absolute() or root.resolve() != root: fail('ERASURE_DIRECTORY_INVALID')
    meta = root.lstat()
    if not stat.S_ISDIR(meta.st_mode) or stat.S_IMODE(meta.st_mode) != 0o700: fail('ERASURE_DIRECTORY_INVALID')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if os.fstat(fd).st_ino != meta.st_ino or os.fstat(fd).st_dev != meta.st_dev:
        os.close(fd); fail('ERASURE_DIRECTORY_DRIFT')
    return fd


def read_record(fd, name, community, reconcile=False):
    if not isinstance(name, str) or not FILE.fullmatch(name): fail('ERASURE_FILE_INVALID')
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        with os.fdopen(file_fd, 'rb') as stream:
            meta = os.fstat(stream.fileno())
            if not stat.S_ISREG(meta.st_mode) or meta.st_nlink not in ([1, 2] if reconcile else [1]) or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_uid != os.fstat(fd).st_uid or meta.st_size > 8192: fail('ERASURE_FILE_INVALID')
            raw = stream.read(8193)
            if len(raw) > 8192: fail('ERASURE_FILE_INVALID')
        row = json.loads(raw)
    except (OSError, ValueError, UnicodeError):
        fail('ERASURE_FILE_INVALID')
    if not isinstance(row, dict) or not re.fullmatch(UUID, str(row.get('id', ''))) or row.get('communityId') != community or not isinstance(row.get('actorId'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', row['actorId']) or not iso(row.get('eventEpoch')) or type(row.get('policyRevision')) is not int or row['policyRevision'] < 1 or not iso(row.get('retentionUntil')): fail('ERASURE_ROW_INVALID')
    if name.endswith('.json') and name != row['id'] + '.json': fail('ERASURE_ROW_INVALID')
    return {'name': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'actorId': row['actorId'], 'retentionUntil': row['retentionUntil'], 'inode': meta.st_ino, 'device': meta.st_dev, 'links': meta.st_nlink}


def inventory(fd, community, reconcile=False):
    names = []
    with os.scandir(fd) as entries:
        for entry in entries:
            names.append(entry.name)
            if len(names) > MAX_FILES: fail('ERASURE_INVENTORY_LIMIT')
    rows = [read_record(fd, name, community, reconcile) for name in sorted(names)]
    if reconcile:
        groups = {}
        for row in rows: groups.setdefault((row['device'], row['inode']), []).append(row)
        for group in groups.values():
            if any(row['links'] != len(group) for row in group): fail('ERASURE_LINKS_INVALID')
            if len(group) == 2 and (sum(row['name'].endswith('.json') for row in group) != 1 or group[0]['sha256'] != group[1]['sha256']): fail('ERASURE_LINKS_INVALID')
    digest = hashlib.sha256(''.join(row['name'] + '\0' + row['sha256'] + ('\0' + str(row['device']) + ':' + str(row['inode']) + ':' + str(row['links']) if reconcile else '') + '\n' for row in rows).encode()).hexdigest()
    return rows, digest


def selected(rows, actor, expired, now, reconcile=False):
    if reconcile: return [row for row in rows if row['links'] == 2 and row['name'].startswith('.pending-')]
    return [row for row in rows if row['retentionUntil'] <= now] if expired else [row for row in rows if row['actorId'] == actor]


def prepare(directory, community, *, actor=None, expired=False, now=None, reconcile=False):
    now = execution_now() if now is None else now
    selector(community, actor, expired, now, reconcile)
    fd = root_fd(directory)
    try:
        rows, digest = inventory(fd, community, reconcile)
        return {'schema': 'event-jump-receipt-erasure-v1', 'operationId': str(uuid.uuid4()), 'communityId': community,
                'mode': 'reconcile' if reconcile else 'expired' if expired else 'participant', 'actorId': actor, 'preparedAt': now,
                'inventorySha256': digest, 'beforeCount': len(rows),
                'files': [{'name': row['name'], 'sha256': row['sha256']} for row in selected(rows, actor, expired, now, reconcile)]}
    finally:
        os.close(fd)


class PartialErasure(RuntimeError):
    def __init__(self, receipt):
        super().__init__('ERASURE_PARTIAL_RECONCILE')
        self.receipt = receipt


def execute(plan, directory, *, apply=False):
    if not isinstance(plan, dict) or set(plan) != {'schema', 'operationId', 'communityId', 'mode', 'actorId', 'preparedAt', 'inventorySha256', 'beforeCount', 'files'} or plan['schema'] != 'event-jump-receipt-erasure-v1' or not re.fullmatch(UUID, str(plan['operationId'])) or plan['mode'] not in ['expired', 'participant', 'reconcile']: fail('ERASURE_PLAN_INVALID')
    expired, reconcile = plan['mode'] == 'expired', plan['mode'] == 'reconcile'
    selector(plan['communityId'], plan['actorId'], expired, plan['preparedAt'], reconcile)
    fd = root_fd(directory)
    try:
        rows, digest = inventory(fd, plan['communityId'], reconcile)
        if digest != plan['inventorySha256'] or len(rows) != plan['beforeCount']: fail('ERASURE_INVENTORY_DRIFT')
        targets = selected(rows, plan['actorId'], expired, plan['preparedAt'], reconcile)
        finals = {(row['device'], row['inode']): row for row in rows if row['links'] == 2 and row['name'].endswith('.json')}
        if plan['files'] != [{'name': row['name'], 'sha256': row['sha256']} for row in targets]: fail('ERASURE_PLAN_INVALID')
        at = execution_now()
        if expired and any(row['retentionUntil'] > at for row in targets): fail('ERASURE_NOT_EXPIRED')
        receipt = {'schema': 'event-jump-receipt-erasure-result-v1', 'operationId': plan['operationId'], 'executedAt': at,
                   'status': 'DRY_RUN', 'mode': plan['mode'], 'eligibleCount': len(targets), 'removedCount': 0, 'beforeCount': len(rows), 'afterCount': len(rows),
                   'separateScopesRequireReadback': ['canonical-event-entries', 'private-exports', 'backups-and-downstream-copies']}
        if not apply: return receipt
        try:
            for row in targets:
                if expired and row['retentionUntil'] > execution_now(): fail('ERASURE_NOT_EXPIRED')
                current = read_record(fd, row['name'], plan['communityId'], reconcile)
                if current != row: fail('ERASURE_FILE_DRIFT')
                if reconcile:
                    final = finals[(row['device'], row['inode'])]
                    if read_record(fd, final['name'], plan['communityId'], reconcile) != final: fail('ERASURE_FILE_DRIFT')
                named = os.stat(row['name'], dir_fd=fd, follow_symlinks=False)
                if named.st_ino != current['inode'] or named.st_dev != current['device'] or named.st_nlink != current['links']: fail('ERASURE_FILE_DRIFT')
                os.unlink(row['name'], dir_fd=fd); receipt['removedCount'] += 1
                os.fsync(fd)
            after, _ = inventory(fd, plan['communityId'])
            removed = {row['name'] for row in targets}
            expected = {row['name']: row['sha256'] for row in rows if row['name'] not in removed}
            if {row['name']: row['sha256'] for row in after} != expected: fail('ERASURE_READBACK_DRIFT')
            receipt.update(status='LINKS_RECONCILED_REPLAN_REQUIRED' if reconcile else 'FILES_ERASED', afterCount=len(after))
            return receipt
        except (OSError, RuntimeError):
            receipt.update(status='PARTIAL_RECONCILE', afterCount=None)
            raise PartialErasure(receipt) from None
    finally:
        os.close(fd)


def private_path(value, *, new=False, archive=None):
    target = Path(value)
    if not target.is_absolute() or target.resolve() != target: fail('ERASURE_PRIVATE_PATH_INVALID')
    parent = target.parent.stat()
    if stat.S_IMODE(parent.st_mode) != 0o700 or parent.st_uid != os.geteuid(): fail('ERASURE_PRIVATE_PATH_INVALID')
    repo = Path(__file__).resolve().parents[1]
    if (repo / '.git').exists() and target.is_relative_to(repo): fail('ERASURE_PRIVATE_PATH_INVALID')
    if archive is not None and target.is_relative_to(archive): fail('ERASURE_PRIVATE_PATH_INVALID')
    if new:
        if os.path.lexists(target): fail('ERASURE_NEW_OUTPUT_REQUIRED')
    else:
        meta = target.lstat()
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_uid != os.geteuid(): fail('ERASURE_PRIVATE_PATH_INVALID')
    return target


def write_journal(fd, value):
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    os.lseek(fd, 0, os.SEEK_SET); os.ftruncate(fd, 0)
    with os.fdopen(os.dup(fd), 'wb') as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())


def new_output(target):
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    parent = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(parent)
    except OSError: os.close(fd); raise
    finally: os.close(parent)
    return fd


def read_plan(value, expected):
    target = private_path(value)
    if not re.fullmatch(r'[a-f0-9]{64}', expected): fail('ERASURE_PLAN_SHA_INVALID')
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_uid != os.geteuid() or meta.st_size > 20 * 1024 * 1024: fail('ERASURE_PRIVATE_PATH_INVALID')
        raw = stream.read(20 * 1024 * 1024 + 1)
    if hashlib.sha256(raw).hexdigest() != expected: fail('ERASURE_PLAN_SHA_MISMATCH')
    try: return json.loads(raw)
    except ValueError: fail('ERASURE_PLAN_INVALID')


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        fail('ERASURE_ARGUMENTS_INVALID')


def main():
    parser = SafeParser(description='Offline receipt plan/dry-run; live apply requires exact approval and an already stopped exhibition service.')
    operations = parser.add_subparsers(dest='operation', required=True, parser_class=SafeParser)
    plan_args = operations.add_parser('plan')
    plan_args.add_argument('--directory', required=True, type=Path); plan_args.add_argument('--community-id', required=True)
    group = plan_args.add_mutually_exclusive_group(required=True)
    group.add_argument('--actor'); group.add_argument('--expired', action='store_true'); group.add_argument('--reconcile', action='store_true')
    plan_args.add_argument('--output', required=True, type=Path)
    preview = operations.add_parser('dry-run'); preview.add_argument('--directory', required=True, type=Path)
    live = operations.add_parser('apply'); live.add_argument('--apply', action='store_true'); live.add_argument('--receipt', type=Path)
    for operation in [preview, live]:
        operation.add_argument('--plan', required=True, type=Path); operation.add_argument('--expected-sha', required=True)
    args = parser.parse_args(); os.umask(0o077)
    if args.operation == 'plan':
        target = private_path(args.output, new=True, archive=args.directory)
        plan = prepare(args.directory, args.community_id, actor=args.actor, expired=args.expired, reconcile=args.reconcile)
        fd = new_output(target)
        try: write_journal(fd, plan)
        finally: os.close(fd)
        print(json.dumps({'operationId': plan['operationId'], 'status': 'PREPARED_NOT_APPLIED', 'beforeCount': plan['beforeCount'], 'selectedCount': len(plan['files'])}))
        return 0
    plan = read_plan(args.plan, args.expected_sha)
    if args.operation == 'dry-run':
        print(json.dumps(execute(plan, args.directory))); return 0
    community = 'community_1794221739126_корпспорт-падлхаб-2026'
    if plan.get('communityId') != community: fail('ERASURE_LIVE_SCOPE_INVALID')
    if os.geteuid() != 0 or socket.gethostname() != '3170594-cd19972': fail('ERASURE_WRONG_HOST_OR_USER')
    directory = Path('/var/lib/padlhub-jump-exhibition') / hashlib.sha256(community.encode()).hexdigest()[:16]
    if directory.stat().st_uid != pwd.getpwnam('padlhub-jump-exhibition').pw_uid: fail('ERASURE_DIRECTORY_OWNER_INVALID')
    if not args.apply:
        print(json.dumps(execute(plan, directory))); return 0
    if args.receipt is None: fail('ERASURE_RECEIPT_REQUIRED')
    target = private_path(args.receipt, new=True, archive=directory)
    # Same lock as first activation: no publication/recovery may restart this service mid-erasure.
    with open('/run/lock/padlhub-jump-live.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for property_name, expected in [('ActiveState', 'inactive'), ('MainPID', '0')]:
            value = subprocess.check_output(['systemctl', 'show', '-p', property_name, '--value', 'padlhub-jump-exhibition.service'], text=True, stderr=subprocess.PIPE).strip()
            if value != expected: fail('ERASURE_SERVICE_MUST_BE_STOPPED')
        fd = new_output(target)
        try:
            write_journal(fd, {'operationId': plan.get('operationId'), 'status': 'STARTED_RECONCILE_IF_INTERRUPTED'})
            try: receipt = execute(plan, directory, apply=True); code = 0
            except PartialErasure as error: receipt = error.receipt; code = 1
            write_journal(fd, receipt); print(json.dumps(receipt)); return code
        finally: os.close(fd)


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as error:
        reason = str(error)
        print(reason if re.fullmatch(r'ERASURE_[A-Z_]+', reason) else 'ERASURE_FAILED', file=sys.stderr)
        sys.exit(1)
