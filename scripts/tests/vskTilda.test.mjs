import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const settings = fs.readFileSync(new URL('../../docs/vsk-tilda/1-settings.html', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('../../docs/vsk-tilda/2-controller.html', import.meta.url), 'utf8');
const script = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('VSK Tilda sells only the fixed monthly offer and never an annual or arbitrary product', () => {
  const window = {};
  vm.runInNewContext(script(settings), { window });
  const c = window.PHVSK_CONFIG;
  assert.equal(c.subscription.monthly.offerKey, 'vsk');
  assert.equal(c.subscription.monthly.checkoutUrl, '');
  assert.equal(c.subscription.annual, undefined);
  assert.equal(c.subscription.activeBookingsLimit, 8);
  assert.equal(c.schedule.booking, 'lk');
  assert.deepEqual(JSON.parse(JSON.stringify(c.schedule.categories.map(x => [x.directionId, x.typeId]))), [[6975,2349],[6975,1613],[5278,839]]);
  assert.equal(c.schedule.viva.enabled, false);
  new Function(script(controller));
});
