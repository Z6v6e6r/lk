import { createHash } from "node:crypto";
const sha = value => createHash("sha256").update(value).digest("hex");
export const bookingPrepareFailurePreimage = "1f0643770dd8c612f843229e6c81819fa907da7b644715593f587a5a66a116e1";
// Pure edit description; contains no private installed function text.
export function bookingPrepareFailureEdits() {
  const needle = '  msg.statusCode = 503; msg.payload = { code: "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE" }; return [null, msg, null];';
  const replacement = `  msg.statusCode = 503; msg.payload = { code: "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE" };
  try {
    if (typeof global !== "undefined") global.get("lkDiagnostics")?.observe(msg, "booking_prepare", {
      code: "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE", httpStatus: 503,
      sourceHash: "${bookingPrepareFailurePreimage}",
    });
  } catch { /* Observability cannot alter business execution. */ }
  return [null, msg, null];`;
  return { needle, replacement };
}
export function applyBookingPrepareFailureObserver(source, attestation) {
  const { needle, replacement } = bookingPrepareFailureEdits();
  if (typeof source !== "string" || sha(source) !== bookingPrepareFailurePreimage
    || attestation.preimageHash !== bookingPrepareFailurePreimage || source.split(needle).length !== 2) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
  const candidate = source.replace(needle, replacement);
  if (sha(candidate) !== attestation.candidateHash) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
  return candidate;
}
