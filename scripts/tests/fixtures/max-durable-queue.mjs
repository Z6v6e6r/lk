import fs from 'node:fs';
import { MAX_OUTBOX_RESUME_TOPOLOGY as routes, sha256, nodeSha256 } from '../../nodered_max_outbox_resume.mjs';
import { MAX_DURABLE_QUEUE_REQUIRED_IDS } from '../../prepare_max_durable_queue.mjs';
const source = name => fs.readFileSync(new URL('./max-outbox/' + name, import.meta.url), 'utf8');
export const durableGraphFixture = () => routes.flatMap(r => {
  const n = (id, type, fields = {}) => ({ id, type, z: r.tab, wires: [], ...fields });
  const sender = n(r.sender, 'maxbot-send', { name: 'Synthetic shared sender', bot: r.bot, d: true,
    x: 100, y: 100, wires: [[r.sendDebug, r.ack]], opaque: 'preserved' });
  return [n(r.tab, 'tab'), n(r.bot, 'maxbot-config'), sender, { ...sender, id: r.newSender, name: r.newName, d: false },
    n(r.receiver, 'maxbot-receive', { bot: r.bot, d: true }), n(r.callback, 'function', { d: true, func: 'return null;' }),
    n(r.poller, 'inject', { d: false, once: true, repeat: '5', wires: [[r.pull]] }),
    n(r.pull, 'function', { func: source('pull-before.function.txt').replace('connector=MAX_BOT', 'connector=' + r.connector), wires: [[r.http]] }),
    n(r.http, 'http request', { wires: [[r.parse]] }), n(r.parse, 'function', { func: 'return [msg,null];', outputs: 2, wires: [[r.split], [r.error]] }),
    n(r.split, 'split', { wires: [[r.dispatch]] }), n(r.dispatch, 'function', {
      func: source('dispatch-before.function.txt'), outputs: 2, wires: [[r.newSender], [r.error]] }),
    n(r.error, 'debug', { active: false, complete: 'payload' }), n(r.sendDebug, 'debug', { active: false, complete: 'payload' }),
    n(r.ack, 'function', { func: 'return null;' })];
});
export const durablePins = raw => {
  const flow = JSON.parse(raw.toString());
  return { flowSha256: sha256(raw), nodeSha256: Object.fromEntries(MAX_DURABLE_QUEUE_REQUIRED_IDS.map(id => [id, nodeSha256(flow.find(n => n.id === id))])) };
};
