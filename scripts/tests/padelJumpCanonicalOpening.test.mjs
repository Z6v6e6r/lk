import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The existing CI runs test:jump-live, not test:community-types. Exercise the
// actual canonical generated-graph regressions here without a second fixture.
test('canonical exhibition registration remains open with mandatory rolling consent and upgrades known guards in CI',()=>{
 const pattern='^(selected exhibition join|exhibition registration renews|ordinary EVENT communities preserve|actual historical V2 and V3 join guards|registration guard refuses drift)';
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-reporter=tap','--test-name-pattern='+pattern,fileURLToPath(new URL('./eventCommunity.test.ts',import.meta.url))],{encoding:'utf8',timeout:10000,env});
 assert.equal(result.error,undefined);
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/^# pass 5$/m,'all five actual boundary/compatibility/upgrade regressions executed');
 assert.match(result.stdout,/^# fail 0$/m);
});
