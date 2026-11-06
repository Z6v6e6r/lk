import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
const nonce = crypto.randomBytes(8).toString('hex');
const name = `fpr-level-test-${nonce}`, label = `padlhub.fpr-level-test=${nonce}`;
const run = args => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`FPR test Docker command failed: ${r.stderr?.slice(0, 200)}`);
  return r.stdout.trim();
};
let created = false;
try {
  run(['run', '--detach', '--rm', '--name', name, '--label', label, '-p', '127.0.0.1::27017',
    'mongo:8.0', '--replSet', 'fprLevelTest', '--bind_ip_all']);
  created = true;
  const published = run(['port', name, '27017/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(published)) throw new Error('Unexpected test Mongo publication');
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = spawnSync('docker', ['exec', name, 'mongosh', '--quiet', '--eval',
      'try { rs.initiate({_id:"fprLevelTest",members:[{_id:0,host:"localhost:27017"}]}) } catch(e) {}'], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Test Mongo did not start');
  const uri = `mongodb://${published}/?directConnection=true&replicaSet=fprLevelTest`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try { await client.connect(); await client.db('admin').command({ ping: 1 }); } finally { await client.close(); }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'scripts/tests/fprLevelLedger.mongo.test.mjs', 'scripts/tests/fprStartBootstrap.mongo.test.mjs'],
    { stdio: 'inherit', env: { ...process.env, FPR_LEVEL_TEST_MONGO_URI: uri } });
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  if (created) {
    const observed = run(['inspect', '--format', '{{index .Config.Labels "padlhub.fpr-level-test"}}', name]);
    if (observed !== nonce) {
      process.stderr.write('Refusing to remove an unowned container\n'); process.exitCode = 1;
    } else run(['rm', '--force', name]);
  }
}
