"""Physical loopback sshd fixture; run only inside the disposable network=none container."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

root = Path('/var/www/html')
store = root / 'lk-frontend-releases'
store.mkdir()
os.chown(store, 41111, 41111)
(root / 'lk').mkdir()
(root / 'lk/index.html').write_text('legacy-preserved')
old = store / ('1'*40 + '-' + 'a'*16)
old.mkdir()
(old / 'fonts').mkdir()
helper = Path('/usr/local/libexec/lk-frontend/frontend-release-remote.py')
import importlib.util
spec = importlib.util.spec_from_file_location('release', helper)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def content(name, source):
    return json.dumps({'sourceCommit': source, 'sourceDirty': False, 'version': source}).encode() if name == 'release.json' else ('fixture:' + name).encode()

for name in m.FILES: (old / name).write_bytes(content(name, '1'*40))
(store / 'current').symlink_to(old.name)
(root / 'lk-frontend-current').symlink_to('lk-frontend-releases/current')
os.lchown(root / 'lk-frontend-current', 0, 0)
root.chmod(0o755)
Path('/run/sshd').mkdir(parents=True, exist_ok=True)
keys = Path('/tmp/keys')
keys.mkdir(mode=0o700)
for name in ['host', 'client']:
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(keys/name)], check=True)
Path('/etc/ssh/authorized_keys/lk-frontend').write_text('restrict ' + (keys/'client.pub').read_text())
Path('/etc/ssh/authorized_keys/lk-frontend').chmod(0o644)
(keys/'known_hosts').write_text('[127.0.0.1]:2222 ' + (keys/'host.pub').read_text())
config = Path('/tmp/sshd_config')
config.write_text('Port 2222\nListenAddress 127.0.0.1\nHostKey /tmp/keys/host\nPidFile /tmp/sshd.pid\nUsePAM no\nStrictModes yes\nPasswordAuthentication no\nLogLevel ERROR\nInclude /fixture/lk-frontend.conf\n')
subprocess.run(['/usr/sbin/sshd', '-t', '-f', str(config)], check=True)
effective = subprocess.check_output(['/usr/sbin/sshd', '-T', '-f', str(config), '-C', 'user=lk-frontend,host=localhost,addr=127.0.0.1'], text=True)
for line in ['disableforwarding yes', 'permittty no', 'permituserrc no']:
    assert line in effective
sshd = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(config)], stderr=open('/tmp/sshd.log', 'w'))
ssh = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/tmp/keys/known_hosts', '-i', str(keys/'client'), '-p', '2222']
code_hash = hashlib.sha256(helper.read_bytes()).hexdigest()
command = 'lk-frontend-v1 ' + code_hash

def invoke(request, requested=command, extra=None):
    return subprocess.run(ssh + (extra or []) + ['lk-frontend@127.0.0.1', requested], input=json.dumps(request), text=True, capture_output=True, timeout=10)

def call(request):
    result = invoke(request)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

try:
    for attempt in range(30):
        result = invoke({'op': 'inspect'})
        if result.returncode == 0: break
        if 'Connection refused' not in result.stderr: raise AssertionError(result.stderr)
        time.sleep(0.1)
    previous = call({'op': 'inspect'})
    print('phase: authenticated pinned helper', flush=True)
    for denied in ['', 'sh', 'touch /tmp/forbidden', 'python3 -c print(1)', 'curl http://127.0.0.1', 'internal-sftp', 'lk-frontend-v1 ' + '0'*64]:
        result = invoke({}, requested=denied)
        assert result.returncode != 0 and 'pinned static protocol' in result.stderr
    assert not Path('/tmp/forbidden').exists()
    forwarding = subprocess.run(ssh + ['-W', '127.0.0.1:2222', 'lk-frontend@127.0.0.1'], capture_output=True, text=True, timeout=10)
    assert forwarding.returncode != 0 and 'administratively prohibited' in forwarding.stderr
    pty = invoke({'op': 'inspect'}, extra=['-tt'])
    assert 'PTY allocation request failed' in pty.stderr
    # An unprivileged publisher cannot modify unrelated server paths, even without sshd.
    denial = subprocess.run(['python3', '-c', '''
import os
from pathlib import Path
os.setgroups([]); os.setgid(41111); os.setuid(41111)
for source,target in [('/var/www/html/lk','/var/www/html/stolen'),('/var/www/html/lk-frontend-current','/var/www/html/changed')]:
 try: os.rename(source,target); raise AssertionError('write escaped static store')
 except PermissionError: pass
try: Path('/usr/local/libexec/lk-frontend/frontend-release-remote.py').write_text('changed'); raise AssertionError('helper writable')
except OSError as error: assert error.errno in [1, 13, 30]
'''], capture_output=True, text=True)
    assert denial.returncode == 0, denial.stderr
    print('phase: command, forwarding, PTY and UID restrictions passed', flush=True)
    token = 'b'*32
    candidate = '2'*40+'-'+'b'*16
    call({'op':'acquire','token':token,'previous':previous,'candidate':candidate})
    def upload(name, **overrides):
        data=content(name,'2'*40)
        req={'op':'upload','token':token,'candidate':candidate,'name':name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'data':base64.b64encode(data).decode()}
        req.update(overrides)
        return invoke(req)
    for name in ['../index.html','/tmp/escape','index.html','bundle-dev.js']:
        assert upload(name).returncode != 0
    assert upload('bundle.js', token='c'*32).returncode != 0
    assert upload('bundle.js', candidate=old.name).returncode != 0
    for name in m.FILES:
        result=upload(name)
        assert result.returncode == 0, result.stderr
    assert upload('bundle.js').returncode != 0
    print('phase: upload negative cases and 16 artifacts passed', flush=True)
    expected=m.inventory(store/candidate)
    call({'op':'publish','token':token,'expected':expected})
    assert (root/'lk-frontend-current').resolve()==store/candidate
    assert upload('bundle.js').returncode != 0
    call({'op':'rollback','token':token})
    call({'op':'finish','token':token,'rolledBack':True})
    assert call({'op':'inspect'})==previous
    assert (root/'lk/index.html').read_text()=='legacy-preserved'
    print('PASS: real forced SSH, code pin, forwarding/PTY denial, confined UID, upload/publish/rollback')
finally:
    sshd.terminate()
    sshd.wait(timeout=5)
