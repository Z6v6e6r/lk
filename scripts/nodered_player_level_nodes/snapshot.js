// Refresh compatibility snapshots from CUP before their existing membership logic.
// Existing authorization and operation handlers remain downstream unchanged.
const targets = [];
const collect = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 5) return;
  if (Array.isArray(value)) { value.forEach(item => collect(item, depth + 1)); return; }
  for (const key of ['member', 'creator', 'actor', 'owner', 'user', 'manager', 'target', 'participant']) {
    if (value[key] && typeof value[key] === 'object') targets.push(value[key]);
  }
  if (Array.isArray(value.members)) targets.push(...value.members);
  for (const key of ['data', 'result', 'community', 'communities']) if (value[key]) collect(value[key], depth + 1);
};
collect(msg.payload);
if (msg._gameCommunityAutoJoin?.member) targets.push(msg._gameCommunityAutoJoin.member);
const ids = [...new Set(targets.map(member => member?.id || member?.clientId).filter(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)))];
const fail = error => {
  msg.statusCode = error?.message === 'LEVEL_AUTH_REQUIRED' ? 401 : 503; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  msg.payload = { error: 'LEVEL_UNAVAILABLE', message: 'Не удалось проверить уровень ЦУП' };
  node.send([null, msg]); node.done();
};
const authorization = msg.req?.headers?.authorization || msg.req?.headers?.Authorization;
if (msg.req && (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization))) { fail(new Error('LEVEL_AUTH_REQUIRED')); return; }
if (ids.length > 1000) { fail(); return; }
const read = clientIds => new Promise((resolve, reject) => {
  let child;
  try { child = nodeChildProcess.spawn('/usr/bin/node', ['/opt/padlhub-player-level/current/level.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production' } }); }
  catch { reject(); return; }
  let output = '', bytes = 0, finished = false;
  const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
  const finish = (result, error) => { if (finished) return; finished = true; clearTimeout(timer); result ? resolve(result) : reject(new Error(error || 'LEVEL_UNAVAILABLE')); };
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) child.kill('SIGTERM'); else output += chunk.toString('utf8'); });
  child.stderr.on('data', () => {}); child.on('error', () => finish());
  child.on('close', () => { let result; try { result = JSON.parse(output); } catch {} finish(result?.ok === true && Array.isArray(result.items) ? result.items : null, result?.error); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ operation: clientIds.length ? 'read' : 'verify', actorId: 'system:community-level-snapshot', clientIds, ...(msg.req ? { authorization } : {}) }));
});
(async () => {
  const chunks = [];
  for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
  if (!chunks.length && msg.req) chunks.push([]);
  const rows = (await Promise.all(chunks.map(read))).flat();
  const byId = new Map(rows.map(row => [row.clientId, row]));
  for (const member of targets) {
    const row = byId.get(member?.id || member?.clientId);
    member.levelScore = row?.ratingNumeric ?? null; member.levelLabel = row?.rating ?? null;
    if ('ratingNumeric' in member) member.ratingNumeric = row?.ratingNumeric ?? null;
    if ('rating' in member) member.rating = row?.rating ?? null;
    if ('levelNumeric' in member) member.levelNumeric = row?.ratingNumeric ?? null;
    if ('currentLevel' in member) member.currentLevel = row?.ratingNumeric ?? null;
    if ('level' in member) member.level = row?.rating ?? null;
  }
  node.send([msg, null]); node.done();
})().catch(fail);
return;
