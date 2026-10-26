// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "roster_preflight", { sourceHash: "fa3668ba4573b77126f080e2f290554ee8a71b68d2555d7e596f4fe33637fa1d", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};
const rosterTouched = ["participants", "waitlist"].some((key) => Object.prototype.hasOwnProperty.call(body, key));
if (!rosterTouched) return [msg, null];
const gameId = String(msg.req?.params?.gameId || "").trim();
if (!gameId) return [msg, null];
msg._partnerRosterPatch = { body, gameId };
msg.payload = [{ id: gameId, archived: { $ne: true } }, { limit: 2 }];
return [null, msg];
