"""Persistent custody for the original native palette upload, never an npm runner.

No timeout, lost client, child error or signal handler returns a foreign lease or
releases locks. A new command is an explicit operator action, never a retry loop.
"""
from pathlib import Path
import os
import sys
import stat
import json
import hashlib
import fcntl
import subprocess
import signal
import time
import re

LOCKS = [Path('/root/.node-red/.padlhub-reviewed-flow-deploy.lock'),
         Path('/run/lock/phab-api-release.lock'), Path('/run/lock/phab-cup-release.lock'),
         Path('/opt/padlhub-max-inbound/.release.lock')]
MACHINE = '8ce8a8be56a2769f05efbfca031d2be3bdc84fa25583dd72359a7a674e76ed9a'


def need(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def sync(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read(file, uid=0, limit=1048576):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st, named = os.fstat(fd), os.lstat(file)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == uid and st.st_gid == (0 if uid == 0 else os.getgid())
             and stat.S_IMODE(st.st_mode) == 0o600 and st.st_nlink == 1 and st.st_size <= limit
             and (st.st_dev, st.st_ino) == (named.st_dev, named.st_ino), 'ADAPTER_HOLDER_FILE')
        raw = os.read(fd, limit + 1)
        need(len(raw) <= limit, 'ADAPTER_HOLDER_LIMIT')
        return raw
    finally:
        os.close(fd)


def put(file, value):
    raw = (json.dumps(value, sort_keys=True) + '\n').encode()
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    sync(file.parent)


def acquire_locks(paths=LOCKS, uid=0):
    descriptors = []
    try:
        for file in paths:
            fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            descriptors.append(fd)
            st, named = os.fstat(fd), file.lstat()
            need(stat.S_ISREG(st.st_mode) and st.st_uid == uid and st.st_nlink == 1
                 and stat.S_IMODE(st.st_mode) == 0o600
                 and (st.st_dev, st.st_ino) == (named.st_dev, named.st_ino), 'ADAPTER_HOLDER_LOCK_FILE')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptors
    except BaseException:
        # Nothing has been loaned yet. Close, never LOCK_UN on a shared OFD.
        for fd in descriptors:
            os.close(fd)
        raise


def epoch(pid):
    raw = Path('/proc/' + str(pid) + '/stat').read_text()
    need(raw.startswith(str(pid) + ' ('), 'ADAPTER_HOLDER_PROCESS')
    return raw[raw.rindex(') ') + 2:].split()[19]


def private_directory(file):
    st = file.lstat()
    need(stat.S_ISDIR(st.st_mode) and not file.is_symlink() and st.st_uid == 0 and st.st_gid == 0
         and stat.S_IMODE(st.st_mode) == 0o700 and file.resolve() == file, 'ADAPTER_HOLDER_DIRECTORY')


def recovery_state(stage, backup, config, expected_holder_sha):
    records = [stage / 'holder.json'] + sorted(stage.glob('holder-recovery-????????.json'))
    previous_raw = read(records[-1])
    need(sha(previous_raw) == expected_holder_sha, 'ADAPTER_HOLDER_RECOVERY_PIN')
    previous = json.loads(previous_raw)
    try:
        live_ticks = epoch(previous['pid'])
    except (FileNotFoundError, ProcessLookupError):
        live_ticks = None
    need(live_ticks != previous['startTicks'], 'ADAPTER_HOLDER_PREVIOUS_ALIVE')
    plan_raw = read(stage / 'plan.json')
    need(plan_raw == read(backup / 'plan.json'), 'ADAPTER_HOLDER_RECOVERY_PLAN')
    plan = json.loads(plan_raw)
    need(plan['kind'] == 'support-media-adapter-install' and plan['stage'] == str(stage)
         and plan['backupStage'] == str(backup) and plan['operatorSha256'] == config['prepare']['operatorSha256']
         and plan['targetSha256'] == config['targetSha256'], 'ADAPTER_HOLDER_RECOVERY_PLAN')
    original = read(stage / 'predecessor.lease.json')
    need(original == read(backup / 'predecessor.lease.json') and sha(original) == plan['predecessor']['sha256'], 'ADAPTER_HOLDER_RECOVERY_PREDECESSOR')
    lease_raw = read(Path('/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json'))
    if lease_raw == original:
        # Core can die after restoring raw bytes but before directory fsync or
        # either completion copy. Admit only its exact durable intent chain;
        # fresh explicit handback/close must still finish all core proofs.
        intent_raw = read(stage / 'handback-intent.json')
        need(intent_raw == read(backup / 'handback-intent.json'), 'ADAPTER_HOLDER_RECOVERY_RETURNED')
        intent = json.loads(intent_raw)
        need(set(intent) == {'planSha256', 'outcomeSha256', 'predecessorSha256'}
             and intent['planSha256'] == sha(plan_raw) and intent['predecessorSha256'] == sha(original), 'ADAPTER_HOLDER_RECOVERY_RETURNED')
        outcome_name = 'terminal.json' if (stage / 'terminal.json').exists() else 'cancelled.json'
        outcome_raw = read(stage / outcome_name)
        need(outcome_raw == read(backup / outcome_name) and sha(outcome_raw) == intent['outcomeSha256']
             and json.loads(outcome_raw)['planSha256'] == sha(plan_raw), 'ADAPTER_HOLDER_RECOVERY_RETURNED')
        removed_raw = read(stage / 'policy-removed.json')
        need(removed_raw == read(backup / 'policy-removed.json')
             and json.loads(removed_raw) == {'planSha256': sha(plan_raw), 'outcomeSha256': intent['outcomeSha256']}
             and not os.path.lexists('/root/.node-red/.npmrc'), 'ADAPTER_HOLDER_RECOVERY_RETURNED')
    else:
        lease = json.loads(lease_raw)
        need(lease.get('formatVersion') == 4 and lease.get('kind') == plan['kind']
             and lease.get('deploymentId') == plan['operationId'] and lease.get('stage') == str(stage)
             and lease.get('backupStage') == str(backup) and lease.get('planSha256') == sha(plan_raw)
             and lease.get('operatorSha256') == plan['operatorSha256']
             and lease.get('phase') in ['reserved', 'attempted', 'terminal', 'cancelled'], 'ADAPTER_HOLDER_RECOVERY_LOAN')
    sequences = []
    for directory in [stage / 'requests', stage / 'responses']:
        for file in directory.iterdir():
            match = re.fullmatch(r'(\d{8})(?:\.close|\.consumed|\.blocked)?\.json', file.name)
            need(match is not None, 'ADAPTER_HOLDER_RECOVERY_UNKNOWN_FILE')
            read(file, limit=65536)  # retain every old record, never invoke it
            sequences.append(int(match[1]))
    next_sequence = max(sequences, default=0) + 1
    need(next_sequence < 99999999, 'ADAPTER_HOLDER_SEQUENCE_LIMIT')
    return next_sequence, len(records), expected_holder_sha


def operator_request(requests, sequence, request, recovering):
    need(isinstance(request, dict) and set(request) == {'command', 'input', 'native'}, 'ADAPTER_HOLDER_COMMAND')
    if recovering:
        need(request['command'] in ['inspect', 'confirm', 'cancel', 'removePolicy', 'handback', 'close'], 'ADAPTER_HOLDER_RECOVERY_NO_NEW_ATTEMPT')
    if request['command'] == 'close':
        file = requests / (str(sequence).zfill(8) + '.close.json')
        put(file, {**request, 'command': 'handback'})
        return file, True
    return requests / (str(sequence).zfill(8) + '.json'), False


def serve(stage, config_pin, operator, operator_pin, recovery_pin='new'):
    need(os.getuid() == 0 and sha(Path('/etc/machine-id').read_bytes()) == MACHINE, 'ADAPTER_HOLDER_TARGET')
    private_directory(stage)
    need(stage.parent == Path('/root/.node-red') and stage.name.startswith('.padlhub-support-adapter-stage-'), 'ADAPTER_HOLDER_STAGE')
    config_raw = read(stage / 'host-config.json')
    need(sha(config_raw) == config_pin, 'ADAPTER_HOLDER_CONFIG')
    config = json.loads(config_raw)
    need(config.get('schema') == 'SUPPORT_ADAPTER_HOST_V1' and config.get('stage') == str(stage), 'ADAPTER_HOLDER_CONFIG')
    need(operator.name == 'support_photos_adapter_operator.mjs' and operator.resolve() == operator
         and sha(read(operator)) == operator_pin, 'ADAPTER_HOLDER_OPERATOR')
    backup = Path(config['backupStage'])
    private_directory(backup)
    requests, responses = stage / 'requests', stage / 'responses'
    private_directory(requests)
    private_directory(responses)
    recovering = recovery_pin != 'new'
    need(recovery_pin == 'new' or re.fullmatch(r'[a-f0-9]{64}', recovery_pin), 'ADAPTER_HOLDER_RECOVERY_PIN')
    if not recovering:
        need(not list(responses.iterdir()) and not (stage / 'holder.json').exists(), 'ADAPTER_HOLDER_ALREADY_STARTED')
    descriptors = acquire_locks()
    # From this point unexpected errors retain the descriptors in this process.
    # SIGKILL/power loss cannot be caught; persistent v4 custody then remains.
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_args: None)
    pid, ticks = os.getpid(), epoch(os.getpid())
    sequence, recovery_number, previous = recovery_state(stage, backup, config, recovery_pin) if recovering else (1, 0, None)
    holder_file = stage / ('holder-recovery-' + str(recovery_number).zfill(8) + '.json' if recovering else 'holder.json')
    put(holder_file, {'pid': pid, 'startTicks': ticks, 'configSha256': config_pin,
                      'operatorFileSha256': operator_pin, 'fds': descriptors, 'nextSequence': sequence,
                      'recoveryOfSha256': previous})
    while True:
        try:
            file = requests / (str(sequence).zfill(8) + '.json')
            if not file.exists():
                time.sleep(0.1)
                continue
            request_raw = read(file, limit=65536)
            request = json.loads(request_raw)
            need(isinstance(request, dict) and set(request) == {'command', 'input', 'native'}, 'ADAPTER_HOLDER_COMMAND')
            need(sha(read(stage / 'host-config.json')) == config_pin and sha(read(operator)) == operator_pin, 'ADAPTER_HOLDER_SOURCE_DRIFT')
            intent = {'requestSha256': sha(request_raw), 'sequence': sequence, 'configSha256': config_pin,
                      'holderPid': pid, 'holderStartTicks': ticks}
            # No invocation is retried after this durable one-time intent.
            put(responses / (str(sequence).zfill(8) + '.consumed.json'), intent)
            # Each explicit close gets its own immutable derived handback request.
            actual_file, close = operator_request(requests, sequence, request, recovering)
            result = subprocess.run(['/usr/local/bin/node', str(operator), str(stage), config_pin, str(actual_file),
                                     str(pid), ticks, ','.join(str(fd) for fd in descriptors)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    pass_fds=tuple(descriptors), env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C'})
            need(len(result.stdout) <= 65536, 'ADAPTER_HOLDER_RESULT_LIMIT')
            value = json.loads(result.stdout)
            need(isinstance(value, dict) and isinstance(value.get('ok'), bool), 'ADAPTER_HOLDER_RESULT')
            put(responses / (str(sequence).zfill(8) + '.json'), {**intent, 'childExit': result.returncode, 'result': value})
            sequence += 1
            if close and result.returncode == 0 and value.get('ok') is True:
                plan_sha = request['input'].get('expectedPlanSha256')
                plan_raw = read(stage / 'plan.json')
                need(sha(plan_raw) == plan_sha and plan_raw == read(backup / 'plan.json'), 'ADAPTER_HOLDER_CLOSE_PLAN')
                done = read(stage / 'handback-complete.json')
                need(done == read(backup / 'handback-complete.json') and json.loads(done)['planSha256'] == plan_sha, 'ADAPTER_HOLDER_CLOSE_RECEIPT')
                original = read(stage / 'predecessor.lease.json')
                need(original == read(backup / 'predecessor.lease.json')
                     and original == read(Path('/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json'))
                     and sha(original) == json.loads(plan_raw)['predecessor']['sha256']
                     and not os.path.lexists('/root/.node-red/.npmrc'), 'ADAPTER_HOLDER_CLOSE_PREDECESSOR')
                put(stage / 'holder-closed.json', {'planSha256': plan_sha, 'predecessorSha256': sha(original), 'sequence': sequence - 1})
                # Node child has exited; close the last OFDs only after final proof.
                for fd in descriptors:
                    os.close(fd)
                return
        except BaseException as error:
            # Never retry a request with a consumed intent. Human reconciliation
            # requires the saved exact request/response and persistent loan.
            code = str(error) if isinstance(error, RuntimeError) and str(error).startswith('ADAPTER_') else 'ADAPTER_HOLDER_UNKNOWN'
            failure = responses / (str(sequence).zfill(8) + '.blocked.json')
            if not failure.exists():
                try:
                    put(failure, {'code': code, 'automaticRetry': False, 'releaseCustody': False})
                except BaseException:
                    pass
            # Park holding locks. No filesystem command can cause auto-retry.
            while True:
                time.sleep(1)


if __name__ == '__main__':
    try:
        need(len(sys.argv) == 6, 'ADAPTER_HOLDER_ARGUMENTS')
        serve(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]), sys.argv[4], sys.argv[5])
    except BaseException:
        # Startup failure occurs before loan. No npm/service/lease mutation here.
        print(json.dumps({'ok': False, 'code': 'ADAPTER_HOLDER_START_REFUSED'}))
        raise SystemExit(1)
