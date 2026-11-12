# Operator only: explicit fail-closed checks survive Python optimization.
def _require(ok):
    if not ok:
        raise ValueError('OPERATOR_CHECK_REFUSED')
import os, sys, json, pathlib, hashlib, datetime, subprocess, re, stat
RELEASE = '26b4398b1c6476f7207a2641a3770de5d99fd19a'
SOURCE = 'f6209e0b795f49850f2c14cdc391d171de339c803868678cb7732a789e180865'
BUNDLE = 'abc0bd3c7bade52bb46215e8b99f2e4a0a15eea7355178e9af291955dfde7a5c'
TARGET = 'lk_subscription_price_preview_20260908_router'

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def digest(b):
    return hashlib.sha256(b).hexdigest()

def run(stage, action):
    p = pathlib.Path(stage)
    st = p.lstat()
    _require(p.parent == pathlib.Path('/root/.node-red') and re.fullmatch('\\.padlhub-preview363-stage-\\d{8}T\\d{6}Z-\\d+', p.name))
    _require(not p.is_symlink() and p.resolve() == p and (st.st_uid == 0) and (stat.S_IMODE(st.st_mode) == 448))
    processes = json.loads(subprocess.check_output(['pm2', 'jlist'], stderr=subprocess.DEVNULL))
    n = [x for x in processes if x.get('name') == 'node-red']
    _require(len(n) == 1)
    process = n[0]
    env = process['pm2_env']
    _require(env['status'] == 'online')
    logs = sorted(set((env[k] for k in ['pm_out_log_path', 'pm_err_log_path'])))
    baseline = p / 'log-baseline.json'
    if action == 'baseline':
        records = []
        for name in logs:
            with open(name, 'rb') as f:
                meta = os.fstat(f.fileno())
                _require(os.stat(name).st_ino == meta.st_ino)
                records.append({'path': name, 'inode': meta.st_ino, 'offset': meta.st_size})
        value = {'at': now(), 'pid': process['pid'], 'restarts': env['restart_time'], 'logs': records}
        fd = os.open(baseline, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 384)
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f)
            f.flush()
            os.fsync(f.fileno())
        return {'status': 'PRIVATE_LOG_BASELINE_SAVED', 'at': value['at'], 'logFiles': len(logs), 'liveFlowWrites': 0}
    _require(action == 'observe')
    bst = baseline.lstat()
    _require(not baseline.is_symlink() and bst.st_uid == 0 and (bst.st_nlink == 1) and (stat.S_IMODE(bst.st_mode) == 384))
    b = json.loads(baseline.read_text())
    out = {'status': 'SAFE_LOG_OBSERVATION', 'at': now(), 'from': b['at'], 'samePid': process['pid'] == b['pid'], 'sameRestartCount': env['restart_time'] == b['restarts'], 'coverageComplete': True, 'readyExpected': 0, 'unavailable': 0, 'crossDayReady': 0, 'crossDayAudits': 0, 'emptyAudits': 0, 'matchingSourceAudits': 0, 'validCorrelationAudits': 0, 'failClosedAudits': 0, 'routerRuntimeErrors': 0, 'malformedEnvelopes': 0, 'responseKinds': {}, 'upstreamStatuses': {}, 'listShapes': {}}
    source = pathlib.Path('/root/.node-red/flows.json').read_bytes()
    graph = json.loads(source)
    target = next((x for x in graph if x.get('id') == TARGET))
    name = target.get('name', '')
    _require(isinstance(name, str) and name and (sum((x.get('type') == 'function' and x.get('name') == name for x in graph)) == 1))
    tag = '\\[function:(?:' + re.escape(TARGET) + '|' + re.escape(name) + ')\\]'
    header = re.compile('^(?:\\d{4}-\\d\\d-\\d\\dT[0-9:.+Z-]+:\\s*)?\\d{1,2} [A-Za-z]{3} \\d\\d:\\d\\d:\\d\\d - \\[(warn|error|info|debug)\\] ' + tag + '\\s(.*)$')
    if logs != sorted((x['path'] for x in b['logs'])):
        out['coverageComplete'] = False
    names = ['preview_empty_tariff_observer_ready', 'preview_empty_tariff_observer_unavailable', 'preview_empty_tariff_guard_diagnostic', 'preview_cross_day_observer_ready', 'preview_cross_day_guard_diagnostic']
    for item in b['logs']:
        path = pathlib.Path(item['path'])
        with path.open('rb') as f:
            current = os.fstat(f.fileno())
            if current.st_ino != item['inode'] or current.st_size < item['offset'] or current.st_size - item['offset'] > 16777216:
                out['coverageComplete'] = False
                continue
            length = current.st_size - item['offset']
            f.seek(item['offset'])
            data = f.read(length)
            if len(data) != length or os.fstat(f.fileno()).st_size < current.st_size or path.stat().st_ino != current.st_ino:
                out['coverageComplete'] = False
                continue
        for line in data.decode('utf-8', errors='replace').splitlines():
            matched = header.fullmatch(line)
            if not matched:
                continue
            level, body = matched.groups()
            if level == 'error' or re.search('\\b(?:ReferenceError|SyntaxError|TypeError)\\b', body):
                out['routerRuntimeErrors'] += 1
            if level != 'warn':
                continue
            timed = re.fullmatch('\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z (\\{.*\\})', body)
            if not timed:
                continue
            try:
                event = json.loads(timed[1])
                _require(isinstance(event, dict))
            except (ValueError, AssertionError):
                out['malformedEnvelopes'] += 1
                continue
            name = event.get('event')
            if type(name) is not str or name not in names:
                continue
            if name == 'preview_empty_tariff_observer_ready':
                if event.get('release') == RELEASE and event.get('sourceHash') == SOURCE and (event.get('bundleSha256') == BUNDLE):
                    out['readyExpected'] += 1
            elif name == 'preview_empty_tariff_observer_unavailable':
                out['unavailable'] += 1
            elif name == 'preview_cross_day_observer_ready':
                out['crossDayReady'] += 1
            elif name == 'preview_cross_day_guard_diagnostic':
                out['crossDayAudits'] += 1
            elif event.get('code') == 'PREVIEW_EMPTY_TARIFF_OBSERVED':
                out['emptyAudits'] += 1
                if event.get('sourceRelease') != RELEASE or event.get('sourceHash') != SOURCE:
                    continue
                out['matchingSourceAudits'] += 1
                if isinstance(event.get('correlationHash'), str) and re.fullmatch('c1:[a-f0-9]{64}', event['correlationHash']):
                    out['validCorrelationAudits'] += 1
                if event.get('httpStatus') == 503 and event.get('outcome') == 'refused' and (event.get('tariffCount') == 0):
                    out['failClosedAudits'] += 1
                for field, dest, allowed in [('responseKind', 'responseKinds', ['object', 'array', 'text', 'number', 'boolean', 'null', 'missing', 'UNKNOWN']), ('tariffListShape', 'listShapes', ['ROOT_ARRAY', 'DIRECT_ARRAY', 'NESTED_ARRAY', 'NO_RECOGNIZED_ARRAY', 'UNKNOWN'])]:
                    v = event.get(field)
                    v = v if isinstance(v, str) and v in allowed else 'UNKNOWN'
                    out[dest][v] = out[dest].get(v, 0) + 1
                v = event.get('upstreamStatus')
                key = str(v) if type(v) is int and 100 <= v <= 599 else 'UNKNOWN'
                out['upstreamStatuses'][key] = out['upstreamStatuses'].get(key, 0) + 1
    raw = pathlib.Path('/root/.node-red/flows.json').read_bytes()
    flow = json.loads(raw)
    node = next((x for x in flow if x.get('id') == TARGET))
    out['sourceStableDuringObservation'] = digest(source) == digest(raw)
    out.update(sourceSha256=digest(raw), functionSha256=digest(node['func'].encode()), nodeCount=len(flow), settingsSha256=digest(pathlib.Path('/root/.node-red/settings.js').read_bytes()))
    return out
if __name__ == '__main__':
    try:
        print(json.dumps(run(*sys.argv[1:])))
    except Exception:
        print(json.dumps({'status': 'SAFE_OBSERVATION_REFUSED'}))
        sys.exit(1)
