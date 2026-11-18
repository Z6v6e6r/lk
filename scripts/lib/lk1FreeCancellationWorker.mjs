import { lk1FreeBegin, lk1FreeStep } from './lk1FreeCancellation.mjs';

export async function runLk1FreeCancellationJob({ job, operations, provider,
  shouldStop = () => false, now = () => new Date().toISOString() }) {
  if (shouldStop()) return { state: 'STOPPED' };
  if (job?.kind !== 'LK1_FREE_CANCEL_JOB_V1' || !job.binding) return { state: 'INVALID_JOB' };
  const begun = lk1FreeBegin({ tenantKey: job.tenantKey, actorClientId: job.binding.actorClientId,
    bookingId: job.binding.bookingId, verifyOnly: true, job });
  let effect = begun.effect;
  for (let hop = 0; hop < 100; hop++) {
    if (shouldStop()) return { state: 'STOPPED' };
    if (effect.kind === 'reply') return { state: effect.payload.state, reason: effect.payload.details?.code };
    let input;
    try {
      if (effect.kind === 'find') input = { payload: await operations.find(effect.query).limit(1001).toArray() };
      else if (effect.kind === 'update') input = { payload: await operations.updateOne(effect.query, effect.change, effect.options) };
      else if (effect.kind === 'http') input = await provider.request(effect, shouldStop);
      else return { state: 'INVALID_EFFECT' };
    } catch { input = { error: true }; }
    if (shouldStop()) return { state: 'STOPPED' };
    effect = lk1FreeStep(begun.state, input, now());
  }
  return { state: 'PENDING_CONFIRMATION', reason: 'LK1_FREE_CANCEL_HOP_LIMIT' };
}

export function createLk1FreeCancellationProvider({ token, fetchImpl = fetch,
  baseUrl = 'https://api.vivacrm.ru' }) {
  const base = new URL(baseUrl);
  if (base.href !== 'https://api.vivacrm.ru/' && !(base.protocol === 'http:'
    && ['127.0.0.1', '[::1]'].includes(base.hostname) && base.pathname === '/' && !base.search && !base.hash)) throw Error('VIVA_ORIGIN_INVALID');
  return { async request(effect, shouldStop = () => false) {
    if (!['GET', 'PUT'].includes(effect.method) || !effect.path.startsWith('/api/v1/')) throw Error('VIVA_REQUEST_INVALID');
    const credential = await token();
    if (!credential || /[\r\n]/.test(credential)) throw Error('VIVA_TOKEN_UNAVAILABLE');
    if (shouldStop()) return { error: true };
    const r = await fetchImpl(new URL(effect.path, base), { method: effect.method, redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${credential}`,
        Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(effect.body ? { body: JSON.stringify(effect.body) } : {}) });
    if (r.status === 401) token.invalidate?.();
    let payload; try { payload = await r.json(); } catch { payload = null; }
    return { status: r.status, payload };
  } };
}
