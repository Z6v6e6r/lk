import { sha } from './source-hooks.mjs';
// Only observes an explicitly attested existing sender. No resend, response or business edges.
export function addTelegramObservers(flow, attestations) {
  const candidate = structuredClone(flow);
  for (const { id, hash } of attestations) {
    const sender = candidate.find(n => n.id === id);
    if (!sender || sender.type !== 'telegram sender' || sha(JSON.stringify(sender)) !== hash) throw new Error('DIAGNOSTIC_TELEGRAM_SOURCE_DRIFT');
    const caught = `diag_tg_catch_${id}`, observe = `diag_tg_observe_${id}`;
    if (candidate.some(n => [caught, observe].includes(n.id))) throw new Error('DIAGNOSTIC_TELEGRAM_DUPLICATE');
    candidate.push({ id: caught, type: 'catch', z: sender.z, name: 'Telegram scoped exception', scope: [id], uncaught: false, wires: [[observe]] });
    candidate.push({ id: observe, type: 'function', z: sender.z, name: 'Telegram safe transport observation', outputs: 0, wires: [],
      func: 'try { global.get("lkDiagnostics")?.transport(msg, "telegram_transport", msg.error, false); } catch {}\nreturn null;' });
  }
  return candidate;
}
