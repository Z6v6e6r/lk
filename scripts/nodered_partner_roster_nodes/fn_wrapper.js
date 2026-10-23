// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "roster_wrapper", { sourceHash: "919e60ab86afa85e29bbb70dcaf437185da0a5880e72db206389136eeda768f5", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const outputs = (() => {
__LIVE_SOURCE__
})();
const ctx = msg._partnerRosterPatch;
if (!ctx || !outputs?.[0]) return outputs;
const write = outputs[0];
const query = { ...(write.query || {}) };
for (const [key, field] of Object.entries(ctx.preimage)) {
  query[key] = field.exists ? { $eq: field.value, ...(field.value === null ? { $exists: true } : {}) } : { $exists: false };
}
write.query = query;
write.payload.$inc = { ...(write.payload.$inc || {}), revision: 1 };
write.payload = [query, write.payload, { upsert: false }];
delete write.query;
ctx.response = { payload: { ...outputs[1].payload, revision: (ctx.preimage.revision.value ?? 0) + 1 }, statusCode: outputs[1].statusCode, headers: outputs[1].headers };
ctx.autojoin = outputs[3] ? { payload: outputs[3].payload, patch: outputs[3]._gameAutojoinPatch } : null;
return [null, null, null, null, write];
