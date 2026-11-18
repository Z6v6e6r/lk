import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
function run(mode) {
 const result=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./fixtures/noderedHttpDeadlineRuntime.mjs',import.meta.url)),mode],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_TEST_CONTEXT:''}});
 assert.equal(result.error,undefined);
 assert.equal(result.status,0,result.stderr);
 const evidence=JSON.parse(result.stdout);
 assert.equal(evidence.providerCalls,0);assert.equal(evidence.productionAccess,false);
 return evidence;
}
test('official Node-RED HTTP consumer receives the supported profile deadline, not just node metadata',()=>{
 const evidence=run('deadline');
 assert.equal(evidence.negativeControlEffectiveTimeout,120000);
 assert.equal(evidence.preparedEffectiveTimeout,10000);
 assert.equal(evidence.retryLimit,0);assert.equal(evidence.followRedirect,false);
});
test('official profile HTTP transport failure reaches scoped unavailable recovery without hanging or stale401',()=>{
 const evidence=run('transport-error');
 assert.equal(evidence.nativeErrors,1);assert.equal(evidence.nativeErrorSends,0);
 assert.equal(evidence.scopedRecovery,'UNAVAILABLE');assert.equal(evidence.restoredTimeout,250000);
});
