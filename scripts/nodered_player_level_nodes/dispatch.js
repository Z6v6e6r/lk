const fail = code => {
  msg.statusCode = code === 'LEVEL_ALREADY_ASSIGNED' ? 409 : code === 'LEVEL_ARGUMENTS' ? 400 : 503;
  msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  msg.payload = { error: code, message: 'Не удалось получить или сохранить уровень ЦУП' }; node.send(msg); node.done();
};
let child;
try { child = nodeChildProcess.spawn('/usr/bin/node', ['/opt/padlhub-player-level/current/level.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production' } }); }
catch { fail('LEVEL_UNAVAILABLE'); return; }
let output = '', bytes = 0, finished = false;
const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) child.kill('SIGTERM'); else output += chunk.toString('utf8'); });
child.stderr.on('data', () => {});
child.on('error', () => { if (finished) return; finished = true; clearTimeout(timer); fail('LEVEL_UNAVAILABLE'); });
child.on('close', () => {
  if (finished) return; finished = true; clearTimeout(timer);
  let result; try { result = JSON.parse(output); } catch { fail('LEVEL_UNAVAILABLE'); return; }
  if (result?.ok !== true || !Array.isArray(result.items)) { fail(/^LEVEL_[A-Z_]+$/.test(result?.error) ? result.error : 'LEVEL_UNAVAILABLE'); return; }
  msg.statusCode = 200; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  msg.payload = result; node.send(msg); node.done();
});
child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(msg.payload));
return;
