import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;

test('real4.0.9 native func-only activation preserves other instances and has zero provider/DB/inject calls',
  { skip: !runtimeRoot, timeout: 45000 }, async () => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = fork(fileURLToPath(new URL('./fixtures/subscription397NativeRuntimeFixture.mjs', import.meta.url)), [],
      { env, execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result = null, failure = null, settled = false, completed = false, cleanupRequested = false;
    const cleanup = () => { if (!completed && Number.isSafeInteger(child.pid)) { cleanupRequested = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(Error('ISOLATED_REHEARSAL_TIMEOUT')); }, 30000);
        let grace = null;
        child.on('message', value => {
          if (value?.protocol === 'subscription397-rehearsal-failure-v1') failure = value.error;
          else if (value?.protocol === 'subscription397-rehearsal-v1' && !result) {
            result = value;
            // Assertions, RED.stop and HTTP close callbacks already completed.
            // Dispose only this owned fixture process group after bounded grace;
            // no stdio unref/force-exit can turn an assertion failure into PASS.
            grace = setTimeout(cleanup, 250);
          } else failure = 'INVALID_REHEARSAL_PROTOCOL';
        });
        child.on('error', error => { clearTimeout(timeout); if (grace) clearTimeout(grace); reject(error); });
        child.on('close', (code, signal) => {
          if (!(code === 0 || (cleanupRequested && signal === 'SIGTERM'))) failure = 'UNEXPECTED_FIXTURE_EXIT';
          completed = true; clearTimeout(timeout); if (grace) clearTimeout(grace); settled = true; resolve();
        });
      });
      assert.equal(failure, null); assert.ok(settled); assert.ok(result, 'child exit before awaited result is a failure');
      assert.deepEqual(result, { protocol: 'subscription397-rehearsal-v1', runtimeVersion: '4.0.9', providerCalls: 0,
        dbCalls: 0, injectInputs: 0, outputs: 2, unchangedNodeInstances: 4, sourceRestored: true });
    } finally { cleanup(); }
  });
