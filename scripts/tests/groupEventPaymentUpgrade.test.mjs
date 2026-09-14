import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_UPGRADE_TARGETS as targets, composeGroupEventPaymentUpgrade as compose,
  writeGroupUpgradeArtifacts } from '../prepare_group_event_payment_upgrade.mjs';

test('superseded group-only release packet keeps its frozen pins and refuses evolved canonical source', () => {
  const rows=targets.map(t=>({id:t.id,type:'function',func:'return msg;',outputs:1,wires:[[]]}));
  assert.equal(targets[0].canonicalSha256,'ddc8893f9554095195c868297f909ae65cbdf71e22bcb03a668d9b27e4c2f6d0');
  assert.throws(()=>compose(Buffer.from(JSON.stringify(rows)),'old-group-packet'),/Canonical source drift/);
});
test('legacy CLI still rejects repository destination before reading private data',()=>{
  const root=new URL('../../',import.meta.url).pathname.replace(/\/$/,'');
  assert.throws(()=>writeGroupUpgradeArtifacts('/nonexistent-source',root+'/forbidden-upgrade-output','old-group-packet'),/outside Git/);
});
