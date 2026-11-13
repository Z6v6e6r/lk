import {MAX_OUTBOX_RESUME_TOPOLOGY as routes} from '../../nodered_max_outbox_resume.mjs';
export const graphFixture = () => {
  const flow = [];
  for (const r of routes) {
    const add = (id, type, fields = {}) => flow.push({ id, type, z: r.tab, wires: [], ...fields });
    add(r.tab, 'tab', { disabled: false });
    add(r.bot, 'maxbot-config', { name: 'Synthetic bot config', fixtureOpaqueSetting: 'preserve' });
    add(r.sender, 'maxbot-send', { bot: r.bot, d: true, defaultChatId: '',
      x: 100, y: 200, wires: [[r.sendDebug, r.ack]] });
    add(r.receiver, 'maxbot-receive', { bot: r.bot, d: true, wires: [['direct-response']] });
    add(r.callback, 'function', { d: true, func: 'return msg;', wires: [['callback-http']] });
    add(r.poller, 'inject', { d: true, once: true, repeat: '5', wires: [[r.pull]] });
    add(r.pull, 'function', {
      func: `msg.url = base + "/support/outbox/pull?connector=${r.connector}&limit=10"; return msg;`,
      wires: [[r.http]],
    });
    add(r.http, 'http request', { wires: [[r.parse]] });
    add(r.parse, 'function', { func: 'return [msg, null];', wires: [[r.split], [r.error]] });
    add(r.split, 'split', { wires: [[r.dispatch]] });
    add(r.dispatch, 'function', { func: 'return [msg, null];', outputs: 2,
      wires: [[r.sender], [r.error]] });
    add(r.error, 'debug');
    add(r.sendDebug, 'debug');
    add(r.ack, 'function', { func: 'return msg;', wires: [['ack-http']] });
    add(`direct-${r.connector}`, 'function', { func: 'return msg;', wires: [[r.sender]] });
  }
  return flow;
};
