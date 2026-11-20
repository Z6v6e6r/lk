import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFprVivaStartLevel, createFprVivaStartReader } from '../lib/fprStartVivaLevel.mjs';
test('retired Viva level reader never fetches or invents a baseline', async () => {
  let calls = 0; const old = globalThis.fetch; globalThis.fetch = async () => { calls++; throw Error('unexpected provider call'); };
  try {
    assert.throws(() => parseFprVivaStartLevel({ id: 'synthetic', customFields: [] }, 'synthetic'), /VIVA_LEVEL_RETIRED/);
    await assert.rejects(createFprVivaStartReader()(['synthetic']), /VIVA_LEVEL_RETIRED/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});
