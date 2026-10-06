import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBookedOperationMongoReader, createBookedOperationReadHandler } from '../lib/bookedOperationRead.mjs';
import { claims, receipt, token, verifier, path, fixturePrivateKeyPem } from './helpers/bookedOperationReadFixture.mjs';

// No URI => explicit SKIP, never a physical PASS. Only the allocated B1 container is legal.
test('physical synthetic Mongo owner GET and read-only command evidence', {
  skip: !process.env.B1_MONGO_URI,
}, async (t) => {
  assert.equal(process.env.B1_SYNTHETIC_DB_ACK, 'b1-booked-operation-read-20261006');
  const container = process.env.B1_MONGO_CONTAINER;
  assert.match(container, /^b1-booked-operation-read-[a-z0-9-]+$/);
  const inspect = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
  assert.equal(inspect.Config.Labels['padlhub.task'], 'b1-booked-operation-read-20261006');
  assert.equal(inspect.State.Running, true);
  for (const mount of inspect.Mounts) {
    if (mount.Type === 'tmpfs') {
      assert.ok(['/data/db', '/data/configdb'].includes(mount.Destination));
      continue;
    }
    assert.equal(mount.Type, 'volume', 'do not seed host bind mounts');
    assert.equal(mount.Destination, '/data/db');
    assert.equal(mount.Name, container + '-data');
    const volume = JSON.parse(execFileSync('docker', ['volume', 'inspect', mount.Name], { encoding: 'utf8' }))[0];
    assert.equal(volume.Labels['padlhub.task'], 'b1-booked-operation-read-20261006');
  }
  assert.match(inspect.Config.Image, /@sha256:[a-f0-9]{64}$/);
  const uri = new URL(process.env.B1_MONGO_URI);
  assert.equal(uri.protocol, 'mongodb:');
  assert.equal(uri.hostname, '127.0.0.1');
  assert.equal(uri.pathname, '/');
  assert.equal(uri.username + uri.password + uri.search + uri.hash, '');
  const exposed = inspect.NetworkSettings.Ports['27017/tcp'];
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].HostIp, '127.0.0.1');
  assert.equal(exposed[0].HostPort, uri.port);
  const { MongoClient } = await import('mongodb');
  const dbName = 'b1_booked_read_' + randomUUID().replaceAll('-', '');
  const seed = new MongoClient(uri.toString(), { serverSelectionTimeoutMS: 1500 });
  const reader = new MongoClient(uri.toString(), { serverSelectionTimeoutMS: 1500, monitorCommands: true });
  await Promise.all([seed.connect(), reader.connect()]);
  const commands = [];
  reader.on('commandStarted', (event) => commands.push(event.commandName));
  const rows = seed.db(dbName).collection('lk_subscription_daily_booking_ops');
  await rows.insertOne(receipt());
  t.after(async () => { await seed.db(dbName).dropDatabase(); await Promise.all([seed.close(), reader.close()]); });
  const handler = createBookedOperationReadHandler({ verifyDelegation: verifier,
    read: createBookedOperationMongoReader(reader.db(dbName).collection('lk_subscription_daily_booking_ops')) });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}${path}`;
  const get = (proof = token()) => fetch(url, { headers: {
    'X-Subscription-Actor-Delegation': proof, 'X-Correlation-ID': claims.correlation_id } });
  const before = await rows.find({}).toArray();
  for (let i = 0; i < 3; i++) assert.equal((await (await get()).json()).status, 'CONFIRMED');
  if (process.env.B1_LK2_CHECKOUT) {
    const checkout = process.env.B1_LK2_CHECKOUT;
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: checkout, encoding: 'utf8' }).trim(),
      'codex/lk2-booked-operation-read-20261006');
    // Use an asynchronous child: the owner HTTP server must remain responsive in this process.
    const { spawn } = await import('node:child_process');
    const consumer = spawn(process.execPath, ['--import', join(checkout, 'node_modules/tsx/dist/loader.mjs'),
      join(checkout, 'scripts/b1-booked-operation-consumer-rehearsal.ts')], { cwd: checkout, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    consumer.stdout.on('data', (data) => { output += data.toString(); });
    consumer.stderr.on('data', (data) => { output += data.toString(); });
    consumer.stdin.end(JSON.stringify({ baseUrl: url.slice(0, -path.length), claims, privateKeyPem: fixturePrivateKeyPem }));
    const timeout = setTimeout(() => consumer.kill('SIGTERM'), 20_000);
    try {
      const [exitCode] = await once(consumer, 'exit');
      assert.equal(exitCode, 0, output);
      console.log(output.trim());
    } finally {
      clearTimeout(timeout);
    }
  }
  assert.deepEqual(await rows.find({}).toArray(), before);
  assert.equal((await get(token({ sub: randomUUID() }))).status, 404);
  assert.equal((await get(token({ provider_client_id: 'other-synthetic-client' }))).status, 404);
  assert.equal((await get(token({ tenant_key: 'other-tenant' }))).status, 401);
  assert.equal((await get(token({ caller: 'other-caller' }))).status, 401);
  assert.equal((await get(token({ operation_id: randomUUID() }))).status, 401);
  await rows.insertOne(receipt());
  assert.equal((await get()).status, 404, 'duplicate operation must not pick first');
  await rows.deleteMany({});
  assert.equal((await get()).status, 404);
  await rows.insertOne(receipt({ state: 'PENDING_CONFIRMATION' }));
  assert.equal((await (await get()).json()).status, 'PENDING');
  await rows.updateOne({}, { $set: { updatedAt: null } });
  assert.equal((await (await get()).json()).status, 'UNKNOWN');
  await rows.updateOne({}, { $unset: { padlHubOperation: '' } });
  assert.equal((await get()).status, 404);
  await reader.close();
  assert.equal((await get()).status, 503, 'unavailable DB never becomes FAILED');
  assert.ok(commands.length >= 10);
  assert.ok(commands.every((name) => ['find', 'getMore', 'endSessions'].includes(name)), commands.join(','));
  console.log('B1 physical Mongo: repeated HTTP reads preserved receipt; owner commands are read-only.');
});
