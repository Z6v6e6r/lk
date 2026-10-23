"""Explicit local synthetic rehearsal. Uses only a cached nginx image, --network none.
Run: python3 scripts/tests/eventNginxRuntime.py IMAGE_ID SYNTHETIC_CONFIG_DIRECTORY
The directory is generated offline by the preparation module; no production files.
"""
import concurrent.futures
import json
import pathlib
import subprocess
import sys
import time
import uuid
image, directory = sys.argv[1:]
root = pathlib.Path(directory).resolve()
config = (root / 'nginx.conf').read_text().replace('worker_connections 128;', 'worker_connections 1024;')
if 'server_name localhost;' not in config or 'listen 8080;' not in config or 'ssl_certificate' in config:
    raise SystemExit('Synthetic localhost configuration required')
# Only this synthetic upstream sees requests; its log includes URI only.
config = config.replace('http {', '''http {
log_format synthetic "$uri";
map $http_x_synthetic_slow $synthetic_rate { default 0; "1" 1; }
server { listen 127.0.0.1:1880; access_log /tmp/synthetic-upstream.log synthetic;
limit_rate $synthetic_rate;
add_header X-Synthetic-Upstream yes always;
add_header X-Synthetic-Key $http_idempotency_key always;
add_header X-Synthetic-Correlation $http_x_correlation_id always;
return 200 "''' + ('x' * 1024) + '''";
}
''', 1)
(root / 'runtime.conf').write_text(config)
name = 'event-nginx-synthetic-' + uuid.uuid4().hex[:8]
base = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run', '-v', str(root) + ':/etc/nginx/event-test:ro', '-v', str(root / 'proxy.conf') + ':/etc/nginx/snippets/lk-event-community-proxy.conf:ro', '--entrypoint', 'nginx']
def cli(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)
def request(route, method='GET', headers=None, body=b''):
    args=['docker','exec','-i',name,'curl','--http1.1','--silent','--show-error','--include','--max-time','8','--request',method]
    for key,value in (headers or {}).items(): args.extend(['--header',key+': '+value])
    args.extend(['--data-binary','@-','http://127.0.0.1:8080'+route])
    result=cli(args,input=body,timeout=30).stdout.decode()
    head = result.split('\r\n\r\n')[0].split('\r\n')
    return int(head[0].split()[1]), {line.split(':',1)[0].lower(): line.split(':',1)[1].strip() for line in head[1:] if ':' in line}
def count():
    result=cli(['docker','exec',name,'sh','-c','if test -f /tmp/synthetic-upstream.log; then wc -l < /tmp/synthetic-upstream.log; else printf 0; fi'])
    return int(result.stdout)
def start():
    cli(base[:3]+['-d','--name',name]+base[3:]+[image,'-c','/etc/nginx/event-test/runtime.conf','-g','daemon off;'])
    for _ in range(20):
        try:
            if request('/unrelated')[0]==200: return
        except (OSError,subprocess.SubprocessError,IndexError): pass
        time.sleep(.05)
    raise AssertionError('nginx did not start')
def stop():
    subprocess.run(['docker','stop','-t','0',name],capture_output=True)
try:
    cli(base+[image,'-t','-c','/etc/nginx/event-test/runtime.conf'])
    start()
    route='/lk/communities/synthetic/event-game/start'
    key='b5361f1b-1e3d-4faf-88b1-8f93813535f1'
    before=count()
    status,h=request(route,'OPTIONS',{'Origin':'https://padlhub.ru','Access-Control-Request-Headers':'Authorization,Idempotency-Key,X-Correlation-ID'})
    assert status==204 and count()==before and h['access-control-allow-origin']=='https://padlhub.ru'
    assert 'Idempotency-Key' in h['access-control-allow-headers']
    time.sleep(.15)
    status,h=request(route,'POST',{'Origin':'https://padlhub.ru','Idempotency-Key':key,'X-Correlation-ID':'synthetic-request-1'})
    assert status==200 and h['x-synthetic-key']==key and h['x-synthetic-correlation']=='synthetic-request-1'
    assert h['x-correlation-id']=='synthetic-request-1' and h['vary']=='Origin'
    time.sleep(.15)
    status,h=request(route,'POST',{'Origin':'https://untrusted.invalid','X-Correlation-ID':'bad value'})
    assert status==200 and 'access-control-allow-origin' not in h and len(h['x-correlation-id'])==32
    assert h['x-correlation-id']==h['x-synthetic-correlation']
    time.sleep(.15)
    before=count();assert request(route,'POST',body=b'x'*8193)[0]==413 and count()==before
    time.sleep(.15)
    assert request('/lk/communities/synthetic/event-game/finish','POST',body=b'x'*65536)[0]==200
    time.sleep(.15)
    before=count();assert request('/lk/communities/synthetic/event-game/finish','POST',body=b'x'*196609)[0]==413 and count()==before
    assert request(route,'DELETE')[0]==405
    assert request('/unrelated')[0]==200
    stop();start()
    before=count()
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        statuses=list(pool.map(lambda _:request(route,'POST')[0],range(60)))
    upstream=count()-before
    assert 429 in statuses and upstream<30 and all(s in (200,429) for s in statuses)
    assert request('/lk/communities/synthetic/detail')[0]==200
    assert request('/lk/communities/synthetic/legacy','PATCH')[0]==200
    stop();start()
    processes=[]
    for _ in range(6):
        proc=subprocess.Popen(['docker','exec',name,'curl','--silent','--show-error','--max-time','8','--request','POST','--header','X-Synthetic-Slow: 1','http://127.0.0.1:8080'+route],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        processes.append(proc)
    time.sleep(.6)
    assert request(route,'POST')[0]==429
    # Close the container-side test sockets as well as docker exec clients.
    cli(['docker','exec',name,'sh','-c','killall curl || true'])
    for proc in processes:
        proc.communicate(timeout=5)
    time.sleep(.2)
    assert request(route,'POST')[0]==200
    print(json.dumps({'synthetic':True,'nginxSyntax':True,'preflightNoUpstream':True,'corsAllowDeny':True,'correlationAndIdempotency':True,'bodyLimits':True,'burstLimited':True,'legacyRoutesUnaffected':True,'burstUpstreamCount':upstream,'ipConcurrencyAndRelease':True,'productionAccess':False}))
except Exception:
    diagnostic=subprocess.run(['docker','exec',name,'cat','/tmp/event-nginx-error.log'],capture_output=True)
    (root/'runtime-error.log').write_bytes(diagnostic.stdout)
    raise
finally:
    stop()
