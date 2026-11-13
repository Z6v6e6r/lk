// No payload, URL, actor, subscription, booking, token or browser-supplied trace is logged.
export function splitCreateTiming(msg, global, node, leaving, allowedStages, crypto) {
  try {
    const route = (msg.req?.originalUrl || msg.req?.url || '').split('?')[0];
    if (msg._splitCtx?.action !== 'create' && !(msg.req?.method === 'POST' && route === '/lk/games/split/create')) return;
    const now = Date.now();
    const previous = msg._splitCreateTiming;
    const valid = previous && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(previous.trace)
      && Number.isSafeInteger(previous.at) && Number.isSafeInteger(previous.startedAt)
      && previous.startedAt <= previous.at && previous.at <= now && now - previous.startedAt <= 300000;
    if (!leaving) {
      if (valid && allowedStages.includes(previous.stage)) node.warn(JSON.stringify({
        event: 'SPLIT_CREATE_STAGE_TIMING_V1', trace: previous.trace, stage: previous.stage,
        durationMs: now - previous.at, totalMs: now - previous.startedAt, at: new Date(now).toISOString(),
      }));
      return;
    }
    const stage = msg._subscriptionBooking?.step ? `subscription:${msg._subscriptionBooking.step}`
      : msg._splitCtx?.step ? `split:${msg._splitCtx.step}` : 'split:prepare';
    const trace = valid ? previous.trace : crypto?.randomUUID();
    if (!allowedStages.includes(stage) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(trace || '')) return;
    msg._splitCreateTiming = { trace, stage, at: now, startedAt: valid ? previous.startedAt : now };
  } catch { /* Timing is optional and cannot change routing, responses or business effects. */ }
}

export const SPLIT_CREATE_TIMING_TARGETS = ['f3f9a60354d394da', '8f7bd5b482fe9763',
  'lk_subscription_booking_router_20260804', 'lk_subscription_booking_finalize_20260804'];
export const SPLIT_CREATE_RECEIPT_ANCHOR = '    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),';
export const SPLIT_CREATE_RECEIPT_FIELD = `
    // SPLIT_CREATE_RECEIPT_V1_BEGIN
    ...(ctx.managedAction === "CREATE_GAME" && msg._splitCtx?.action === "create" ? {
      createReceipt: { schemaVersion: 1, paymentRef: msg._splitCtx.paymentRef,
        deadlineAt: msg._splitCtx.deadlineAt, assembleDeadlineAt: msg._splitCtx.assembleDeadlineAt }
    } : {}),
    // SPLIT_CREATE_RECEIPT_V1_END`;
export function instrumentSplitCreateTimings(flow) {
  const sources = SPLIT_CREATE_TIMING_TARGETS.map(id => {
    const n = flow.find(n => n.id === id);
    if (n?.type !== 'function' || typeof n.func !== 'string' || n.func.includes('// SPLIT_CREATE_TIMING_V1')) throw Error('Split create timing source drift');
    return n;
  });
  const stages = ['split:prepare'];
  for (const n of sources) {
    const prefix = n.id.startsWith('lk_subscription') ? 'subscription:' : 'split:';
    for (const m of n.func.matchAll(/(?:ctx|splitCtx)\.step\s*(?:===|=)\s*["']([a-z0-9_]+)["']/g)) stages.push(prefix + m[1]);
  }
  // Some stages are assigned by the gateway prepare/finalizer before its router re-enters.
  stages.push('subscription:profile', 'split:create_booking');
  const allowed = [...new Set(stages)].sort();
  for (const n of sources) {
    if (n.id === 'lk_subscription_booking_router_20260804') {
      if (n.func.split(SPLIT_CREATE_RECEIPT_ANCHOR).length !== 2) throw Error('Split create receipt anchor drift');
      n.func = n.func.replace(SPLIT_CREATE_RECEIPT_ANCHOR, SPLIT_CREATE_RECEIPT_ANCHOR + SPLIT_CREATE_RECEIPT_FIELD);
    }
    if ((n.libs || []).some(lib => lib.var === 'splitCreateTimingCrypto')) throw Error('Split timing crypto binding collision');
    const observe = `(${splitCreateTiming.toString()})(msg, global, node, LEAVING, ${JSON.stringify(allowed)}, typeof splitCreateTimingCrypto === 'undefined' ? null : splitCreateTimingCrypto);`;
    n.func = `// SPLIT_CREATE_TIMING_V1\n${observe.replace('LEAVING', 'false')}\ntry {\n${n.func}\n} finally {\n${observe.replace('LEAVING', 'true')}\n}\n`;
    n.libs = [...(n.libs || []), { var: 'splitCreateTimingCrypto', module: 'crypto' }];
    new Function('msg', 'global', 'node', n.func);
  }
  return sources.map(n => ({ id: n.id, fields: ['func', 'libs'] }));
}
