import crypto from "node:crypto";

export const LIVE_GAME_CREATE_FUNC_SHA256 = "08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f";
export const BASE_GAME_CREATE_FUNC_SHA256 = "652c1963ebdf5b670a29436f800102035b06e68568dd3752617303335e1495db";

export const SERVER_OWNED_GAME_TENANT_PRECONDITION = `const tenantKey = (() => {
  try { return toStr(env.get("PADLHUB_PLATFORM_TENANT_KEY")); } catch (_error) { return null; }
})();
if (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Game tenant configuration is unavailable", code: "GAME_TENANT_CONFIG_INVALID" },
  });
  return [null, errMsg, errMsg, null];
}
const requestedTenantKey = toStr(body.tenantKey);
if (requestedTenantKey && requestedTenantKey !== tenantKey) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 403,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Game tenant does not match the configured platform tenant", code: "GAME_TENANT_MISMATCH" },
  });
  return [null, errMsg, errMsg, null];
}`;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const replaceOnce = (source, before, after, label) => {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    fail(`Expected one exact ${label} preimage`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
};

export function patchVivaGameCreateTenantRevisionBase(source) {
  const sourceSha256 = sha256(source);
  if (sourceSha256 === BASE_GAME_CREATE_FUNC_SHA256) return source;
  if (sourceSha256 !== LIVE_GAME_CREATE_FUNC_SHA256) fail("Game create function preimage mismatch");
  let next = replaceOnce(
    source,
    "const record = {\n  id: gameId,\n  tenantKey: toStr(body.tenantKey) || null,",
    `${SERVER_OWNED_GAME_TENANT_PRECONDITION}\n\nconst record = {\n  id: gameId,\n  tenantKey,`,
    "game create tenant contract",
  );
  next = replaceOnce(
    next,
    `const queryFilter = paymentRef
  ? {
      $or: [
        { "metadata.paymentRef": paymentRef },
        { "payment.paymentRef": paymentRef },
      ],
    }
  : { dedupeKey };`,
    `const queryFilter = {
  tenantKey,
  ...(paymentRef ? {
    $or: [
      { "metadata.paymentRef": paymentRef },
      { "payment.paymentRef": paymentRef },
    ],
  } : { dedupeKey }),
};`,
    "game create tenant-bound upsert query",
  );
  const patched = replaceOnce(
    next,
    `    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },`,
    `    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },
    $inc: { revision: 1 },`,
    "game create revision increment",
  );
  if (sha256(patched) !== BASE_GAME_CREATE_FUNC_SHA256) fail("Game create base postimage mismatch");
  return patched;
}
