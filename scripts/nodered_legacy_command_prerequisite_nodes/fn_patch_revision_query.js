const ctx = msg._gamePatchCas && typeof msg._gamePatchCas === "object"
  ? msg._gamePatchCas
  : null;
if (!ctx?.required) return msg;
if (!Number.isSafeInteger(ctx.expectedRevision) || ctx.expectedRevision < 1) {
  throw new Error("Mandatory positive game revision is missing from PATCH CAS context");
}
if (typeof ctx.tenantKey !== "string" || ctx.tenantKey.trim() !== ctx.tenantKey || !ctx.tenantKey) {
  throw new Error("Canonical tenantKey is missing from PATCH CAS context");
}

const args = Array.isArray(msg.payload) ? msg.payload : [];
const query = args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
  ? { ...args[0], tenantKey: ctx.tenantKey, revision: ctx.expectedRevision }
  : { tenantKey: ctx.tenantKey, revision: ctx.expectedRevision };
const update = args[1] && typeof args[1] === "object" && !Array.isArray(args[1])
  ? { ...args[1] }
  : null;
const options = args[2] && typeof args[2] === "object" && !Array.isArray(args[2])
  ? args[2]
  : {};
if (!update) throw new Error("Mandatory revision PATCH update is missing");

update.$inc = {
  ...(update.$inc && typeof update.$inc === "object" ? update.$inc : {}),
  revision: 1,
};
ctx.nextUpdatedAt = update?.$set?.updatedAt || null;
ctx.nextRevision = ctx.expectedRevision + 1;
msg._gamePatchCas = ctx;
msg.payload = [query, update, options];
return msg;
