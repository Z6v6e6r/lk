import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Execute the public contrib constructors used by dedicated senders. Transport
// is synthetic; no provider token, network access or incoming polling is used.
const fixture = name => fs.readFileSync(new URL(`./fixtures/max-response-guard/${name}.js.txt`, import.meta.url), 'utf8');
const load = (name, sdk, RED) => {
  const module = { exports: {} };
  const body = vm.runInNewContext(`(function(require,module,exports){${fixture(name)}\n})`, { Buffer, Error });
  body(dependency => { assert.equal(dependency, '@maxhub/max-bot-api'); return sdk; }, module, module.exports);
  module.exports.default(RED);
};

test('actual config and two dedicated sender constructors do not start incoming polling or send', async () => {
  const types = new Map(), configs = new Map(), hooks = new WeakMap(), requests = [], errors = [];
  class Bot {
    constructor(token) {
      this.api = {
        sendMessageToChat: async (chat, text) => { requests.push({ token, chat, text }); return { message: { body: { mid: 'synthetic-result' } } }; },
        getMyInfo: () => { throw Error('UNEXPECTED_PROVIDER_IDENTITY'); },
        getUpdates: () => { throw Error('UNEXPECTED_INCOMING_POLL'); },
      };
    }
    start() { throw Error('UNEXPECTED_INCOMING_START'); }
  }
  const RED = { nodes: {
    registerType: (name, constructor) => types.set(name, constructor),
    getNode: id => configs.get(id),
    createNode(node, config) {
      node.credentials = { token: `synthetic-${config.id}` };
      node.on = (name, callback) => { const h = hooks.get(node) ?? {}; h[name] = callback; hooks.set(node, h); };
      node.status = () => {};
      node.error = error => errors.push(error);
    },
  } };
  load('maxbot-config', { Bot }, RED);
  load('maxbot-send', { Bot }, RED);
  const Config = types.get('maxbot-config'), Sender = types.get('maxbot-send');
  for (const id of ['main', 'academy']) configs.set(id, new Config({ id }));
  const main = new Sender({ bot: 'main' }), academy = new Sender({ bot: 'academy' });
  assert.equal(requests.length, 0);
  assert.equal(errors.length, 0);
  for (const [node, name] of [[main, 'main'], [academy, 'academy']]) {
    const command = { id: `synthetic-${name}-command` };
    const msg = { chatId: 'synthetic-chat', payload: 'synthetic new reply', supportOutbox: command };
    const outputs = []; let done = 0;
    await hooks.get(node).input(msg, output => outputs.push(output), () => done++);
    assert.equal(done, 1);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].supportOutbox, command); // Existing ACK builder can retain exact command identity.
    assert.equal(outputs[0].payload.message.body.mid, 'synthetic-result');
  }
  assert.deepEqual(requests.map(r => r.token), ['synthetic-main', 'synthetic-academy']);
  assert.equal(errors.length, 0);
});
