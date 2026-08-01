const ctx = msg._gamePatchCas && typeof msg._gamePatchCas === "object"
  ? msg._gamePatchCas
  : null;
if (!ctx?.required) return msg;

const args = Array.isArray(msg.payload) ? msg.payload : [];
const query = args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
  ? { ...args[0] }
  : {};
const update = args[1] && typeof args[1] === "object" && !Array.isArray(args[1])
  ? { ...args[1] }
  : args[1];
const options = args[2] && typeof args[2] === "object" && !Array.isArray(args[2])
  ? args[2]
  : {};

if (Object.prototype.hasOwnProperty.call(ctx, "expectedUpdatedAt") && ctx.expectedUpdatedAt !== undefined) {
  query.updatedAt = ctx.expectedUpdatedAt === null
    ? { $exists: false }
    : ctx.expectedUpdatedAt;
}
if (Number.isInteger(ctx.expectedRevision)) query.revision = ctx.expectedRevision;
if (update && typeof update === "object" && !Array.isArray(update)) {
  update.$inc = {
    ...(update.$inc && typeof update.$inc === "object" ? update.$inc : {}),
    revision: 1,
  };
}
ctx.nextUpdatedAt = update?.$set?.updatedAt || null;
ctx.nextRevision = Number.isInteger(ctx.expectedRevision) ? ctx.expectedRevision + 1 : null;
msg._gamePatchCas = ctx;
msg.payload = [query, update, options];
return msg;
