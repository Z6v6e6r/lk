import test from 'node:test';
import assert from 'node:assert/strict';
import { createJumpStarter } from '../../src/components/padel-jump/start.ts';

function harness(mobile = true) {
  let begins = 0, requests = 0, recalibrations = 0, pending = false, visible = true;
  const starter = createJumpStarter({
    autoTilt: () => mobile,
    enableTilt: () => { requests++; starter.status('requesting'); },
    recalibrate: () => { recalibrations++; starter.status('calibrating'); },
    begin: () => { begins++; }, canBegin: () => visible,
    pending: value => { pending = value; },
  });
  return { starter, state: () => ({ begins, requests, recalibrations, pending }), hide: () => { visible = false; } };
}

test('first mobile play requests permission synchronously and waits for the first calibration sample', () => {
  const h = harness(); h.starter.play();
  assert.deepEqual(h.state(), { begins: 0, requests: 1, recalibrations: 0, pending: true });
  h.starter.play(); assert.equal(h.state().requests, 1);
  h.starter.status('calibrating'); assert.equal(h.state().begins, 0);
  h.starter.status('active'); assert.equal(h.state().begins, 1); assert.equal(h.state().pending, false);
  h.starter.status('active'); assert.equal(h.state().begins, 1);
});

test('desktop and an explicit touch choice start immediately without permission', () => {
  for (const mobile of [false, true]) {
    const h = harness(mobile); if (mobile) h.starter.touch();
    h.starter.play(); assert.equal(h.state().begins, 1); assert.equal(h.state().requests, 0);
  }
});

test('denied, insecure and missing/no-signal sensors fall back without repeating automatic prompts', () => {
  for (const status of ['denied', 'unavailable', 'insecure'] as const) {
    const h = harness(); h.starter.play(); h.starter.status(status);
    assert.equal(h.state().begins, 1); assert.equal(h.state().pending, false);
    h.starter.play(); assert.equal(h.state().begins, 2); assert.equal(h.state().requests, 1);
    h.starter.status('off'); h.starter.play(); assert.equal(h.state().requests, 1);
  }
});

test('selecting touch during a pending start releases the round with manual controls', () => {
  const h = harness(); h.starter.play(); h.starter.touch(); h.starter.status('off');
  assert.equal(h.state().begins, 1); assert.equal(h.state().pending, false);
});

test('late permission/calibration after menu, background or unmount cancellation cannot start a round', () => {
  const h = harness(); h.starter.play(); h.starter.cancel();
  h.starter.status('calibrating'); h.starter.status('active');
  assert.equal(h.state().begins, 0); assert.equal(h.state().pending, false);
});

test('a late grant while the page cannot receive play input does not start behind the prompt/window', () => {
  const h = harness(); h.starter.play(); h.hide(); h.starter.status('active');
  assert.equal(h.state().begins, 0); assert.equal(h.state().pending, false);
});

test('resume with tilt waits for a new neutral sample without requesting permission again', () => {
  const h = harness(); h.starter.status('active'); h.starter.play();
  assert.equal(h.state().recalibrations, 1); assert.equal(h.state().begins, 0);
  h.starter.status('active'); assert.equal(h.state().begins, 1); assert.equal(h.state().requests, 0);
});

test('an explicit sensor request is reused by play rather than opening a second permission sheet', () => {
  const h = harness(); h.starter.status('requesting'); h.starter.play();
  assert.equal(h.state().requests, 0); h.starter.status('calibrating'); assert.equal(h.state().begins, 0);
  h.starter.status('active'); assert.equal(h.state().begins, 1);
});
