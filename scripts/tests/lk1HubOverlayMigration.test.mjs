import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  HUB_OVERLAY_LIVE_CONTRACT,
  buildHubOverlayMigrationCandidate,
} from '../prepare_lk1_hub_overlay_migration.mjs';

const fixture = process.env.LK1_HUB_LIVE_FIXTURE;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const fixtureBytes = () => fs.readFileSync(fixture);
const cloneFixture = () => JSON.parse(fixtureBytes().toString('utf8'));
const gateway = (flow) => flow.find((node) => node.id === HUB_OVERLAY_LIVE_CONTRACT.gatewayId);

test('HUB overlay migration has a one-node exact live contract', () => {
  assert.deepEqual(HUB_OVERLAY_LIVE_CONTRACT, {
    sourceSha256: 'f6c6c9e2da8a751a28075e44521662f794556052b96c17bed3fc00f59f5b502d',
    gatewayId: 'lk_subscription_booking_router_20260804',
    gatewayFuncSha256: 'aa9be7356409f7a486a3b97a3f1278c5a1090a9e27c77193229069cead6fb799',
  });
});

test('HUB overlay migration rejects a flow other than the reviewed preimage', { skip: !fixture }, () => {
  const changed = cloneFixture();
  gateway(changed).func += '\n// fixture drift';
  assert.throws(() => buildHubOverlayMigrationCandidate(Buffer.from(JSON.stringify(changed))),
    /preimage|gateway/i);
});

test('HUB overlay migration changes only gateway.func and is not repeatable', { skip: !fixture }, () => {
  const before = cloneFixture();
  const built = buildHubOverlayMigrationCandidate(fixtureBytes());
  const after = JSON.parse(built.candidateBytes.toString('utf8'));

  assert.deepEqual(built.contract.allowedChanges.map(({ id, fields }) => ({ id, fields })), [{
    id: HUB_OVERLAY_LIVE_CONTRACT.gatewayId,
    fields: ['func'],
  }]);
  assert.equal(built.contract.allowedAdditions.length, 0);
  assert.equal(sha256(built.candidateBytes), 'e672b79ae011f647d5156d840315543b88e471880236374c2aea2eaf0239f223');
  assert.equal(sha256(gateway(after).func), '4eb1e642e00526f5c510cb33b0c4f5a964c0b8642d830da700bc6050d3836432');

  for (let index = 0; index < before.length; index += 1) {
    if (before[index].id === HUB_OVERLAY_LIVE_CONTRACT.gatewayId) {
      assert.deepEqual({ ...after[index], func: before[index].func }, before[index]);
    } else assert.deepEqual(after[index], before[index]);
  }
  assert.doesNotThrow(() => new Function('msg', 'node', 'env', 'global', gateway(after).func));
  assert.throws(() => buildHubOverlayMigrationCandidate(built.candidateBytes), /already|marker|preimage/i);
});
