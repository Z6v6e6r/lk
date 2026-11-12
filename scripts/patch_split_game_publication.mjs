import fs from 'node:fs';
import crypto from 'node:crypto';

const contract = fs.readFileSync(new URL('./nodered_game_publication_nodes/contract.js', import.meta.url), 'utf8');
const once = (s, from, to) => {
  if (s.split(from).length !== 2) throw new Error('Split publication source anchor drift');
  return s.replace(from, to);
};
const enabled = `!msg._gameCreateOwner && String(env.get("LK_SPLIT_GAME_PUBLICATION_ENABLED") || "") === "1"`;

// Pure source-driven composition. This does not import/deploy a flow or query any service.
export function composeSplitPublicationSources(input) {
  if (Object.values(input).some(s => typeof s !== 'string' || s.includes('// SPLIT_PUBLICATION_V1'))) throw new Error('Split publication source generation mismatch');
  const out = { ...input };
  out.prepare = '// SPLIT_PUBLICATION_V1\n' + contract + '\n' + once(out.prepare, 'msg._splitCtx = {',
    `if (${enabled} && body.publicationIntent !== undefined && !splitPublicationIntent(body.publicationIntent)) {\n`
    + '  return fail(400, "Некорректные настройки публикации", { code: "GAME_PUBLICATION_INTENT_INVALID" });\n}\nmsg._splitCtx = {');
  out.prepare = once(out.prepare, '  action: "create",\n', `  action: "create",\n  publicationEnabled: ${enabled},\n  publicationIntent: splitPublicationIntent(body.publicationIntent),\n`);
  out.gateway = '// SPLIT_PUBLICATION_V1\n' + contract + '\n' + once(out.gateway, '  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));\n',
    '  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));\n'
    + '  const publication = !msg._gameCreateOwner ? splitPublicationSnapshot(ctx, msg._splitCtx) : null;\n'
    + '  if (!msg._gameCreateOwner && ctx.caller === "split" && ctx.managedAction === "CREATE_GAME" && ctx.lk1BeforeCreate === true\n'
    + '    && msg._splitCtx?.publicationEnabled === true && msg._splitCtx.publicationIntent\n'
    + '    && decision.benefit.finalPriceMinor === 0 && decision.subscriptionVisitCount === 1 && !publication)\n'
    + '    return lk1Stop(ctx, "GAME_PUBLICATION_CONTRACT_INVALID");\n'
    + '  if (publication) ctx.lk1.publication = publication;\n');
  out.gateway = once(out.gateway, '    const quote = operation.lk1;\n',
    '    const quote = operation.lk1;\n    if (!splitPublicationReplayMatches(quote?.publication, { ...ctx, lk1: quote }, msg._splitCtx)) return lk1Stop(ctx, "GAME_PUBLICATION_INTENT_CHANGED");\n');
  out.gateway = once(out.gateway, '    const actualTarget = ctx.lk1.target;\n',
    '    if (!splitPublicationReplayMatches(operation.lk1?.publication, { ...ctx, lk1: operation.lk1 }, msg._splitCtx)) return lk1Stop(ctx, "GAME_PUBLICATION_INTENT_CHANGED");\n    const actualTarget = ctx.lk1.target;\n');
  // The durable snapshot is already in ctx.lk1 before the existing operation insert.
  // Fence the pre-provider CAS to that same immutable snapshot as well.
  out.gateway = once(out.gateway, '      "lk1.createAttemptedAt": { $exists: false },\n',
    '      "lk1.createAttemptedAt": { $exists: false },\n'
    + '      ...(ctx.lk1.publication ? { "lk1.publication.intentJson": ctx.lk1.publication.intentJson } : {}),\n');
  const finish = '  finishConfirmed(ctx, ctx.confirmedBookingId);';
  out.gateway = once(out.gateway, finish, finish + '\n'
    + '  if (ctx.lk1.publication && ctx.lk1.decision.benefit.finalPriceMinor === 0) {\n'
    + '    msg.payload.serverPublication = { version: 1, state: ctx.lk1.publication.state, operationId: ctx.operationId,\n'
    + '      candidateGameId: splitPublicationGameId(ctx.tenantKey, ctx.exerciseId),\n'
    + '      gameId: ctx.lk1.publication.state === "PUBLISHED" ? ctx.lk1.publication.gameId : null };\n  }');
  // Preserve the pending descriptor through the two existing finalizer paths.
  out.finalize = '// SPLIT_PUBLICATION_V1\n' + out.finalize;
  out.finalize = once(out.finalize, '      gameId: split.gameId || payload.gameId || null,\n',
    '      gameId: split.gameId || payload.gameId || null,\n      serverPublication: payload.serverPublication || null,\n');
  out.finalize = once(out.finalize, '    msg._splitCtx = { ...msg._splitCtx, step: "lk1_checkout_complete" };',
    '    msg._splitCtx = { ...msg._splitCtx, step: "lk1_checkout_complete", serverPublication: payload.serverPublication || null };');
  out.router = '// SPLIT_PUBLICATION_V1\n' + once(out.router, '    gameId: toStr(ctx.gameId) || null,\n',
    '    gameId: toStr(ctx.gameId) || null,\n    serverPublication: ctx.serverPublication || null,\n');
  return out;
}

// A future release must supply the reviewed exact live preimages. Never discover/approve
// an arbitrary preimage from the same input, and never regenerate the broad frozen graph.
export function buildSplitPublicationCandidate(flow, expectedHashes) {
  const names = { prepare: 'Prepare split game payment', gateway: 'Route atomic subscription booking',
    finalize: 'Finalize subscription booking response', router: 'Route Viva split payment' };
  const ids = { prepare: 'f3f9a60354d394da', gateway: 'lk_subscription_booking_router_20260804',
    finalize: 'lk_subscription_booking_finalize_20260804', router: '8f7bd5b482fe9763' };
  const sources = {}, targets = {};
  for (const [key, name] of Object.entries(names)) {
    const rows = flow.filter(n => n.id === ids[key] && n.type === 'function' && n.name === name);
    if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(expectedHashes?.[key] || '')
      || crypto.createHash('sha256').update(rows[0].func).digest('hex') !== expectedHashes[key]) throw new Error('Split publication exact preimage mismatch');
    targets[key] = rows[0].id; sources[key] = rows[0].func;
  }
  const composed = composeSplitPublicationSources(sources), candidate = structuredClone(flow);
  for (const [key, id] of Object.entries(targets)) candidate.find(n => n.id === id).func = composed[key];
  return candidate;
}
