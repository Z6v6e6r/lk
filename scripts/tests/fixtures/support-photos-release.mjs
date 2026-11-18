import { SUPPORT_PHOTO_PREIMAGE_IDS } from '../../prepare_support_photos.mjs';
import { PHOTO_POLLERS, photoPins } from '../../nodered_support_photos_release.mjs';
export function supportPhotoFixture() {
  const [ingress, history, d1, d2, s1, s2, response, prepare] = SUPPORT_PHOTO_PREIMAGE_IDS;
  const z = 'synthetic-tab';
  return [{ id: z, type: 'tab', label: 'Synthetic only', disabled: false },
    { id: ingress, z, type: 'http in', method: 'post', url: '/lk/support/dialogs/events', wires: [[prepare]] },
    { id: history, z, type: 'function', func: 'return [msg,msg]', wires: [['9d2ab6d44c9ab611'], ['ca7984daa2fe8824']] },
    ...[[d1, s1, 'a5d5eca27e9e56da'], [d2, s2, '55b05444842e7b84']].flatMap(([d, s, bot]) => [
      { id: d, z, type: 'function', func: 'return msg', wires: [[s]] },
      { id: s, z, type: 'maxbot-send', bot, wires: [['synthetic-ack']] },
      { id: bot, type: 'maxbot-config', name: 'Synthetic bot' }]),
    { id: response, z, type: 'function', func: 'return [msg,msg]', wires: [['e2e7ac514b442d4a'], ['d6cd11bef22dfad0']] },
    { id: prepare, z, type: 'function', func: 'return msg', wires: [['synthetic-business']] },
    ...PHOTO_POLLERS.map(id => ({ id, z, type: 'inject', d: false, once: false, repeat: '', crontab: '', wires: [[]] })),
    { id: 'lk_subscription_booking_router_20260804', z, type: 'function', func: 'SYNTHETIC_GATEWAY_UNCHANGED', wires: [] },
    { id: 'unrelated', z, type: 'function', func: 'SYNTHETIC_UNCHANGED', opaque: { retained: true }, wires: [] }];
}
export const supportPhotoPins = flow => photoPins(typeof flow === 'string' || Buffer.isBuffer(flow) ? flow : JSON.stringify(flow));
