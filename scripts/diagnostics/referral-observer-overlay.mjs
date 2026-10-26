import { createHash } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const root = "scripts/nodered_games_nodes/";
export const referralObserverBindings = Object.freeze({
  [`${root}fn_referral_subscription_purchase_prepare.js`]: Object.freeze({
    stage: "purchase_prepare", id: "8fe574816fd8bfd7",
    preimageHash: "9f4eab6192370b4f6bcdb3fa11e572a58581748d40ad52f1c78e5d748023ea45",
    candidateHash: "59325f22e574972d749fac979b554be2af80e7055fb5f8a0f47e4d660423beaa",
  }),
  [`${root}fn_referral_subscription_owner_resolve.js`]: Object.freeze({
    stage: "owner_resolve", id: "f96b90a57be61a5c",
    preimageHash: "4441d245345f7f01bd3693d87edaf300f1cbc162fb28ea78cf29f39bacc0da4c",
    candidateHash: "7c5d28daf6ae691d72b18a3eab4d74231b2a09a9187cacb2c9a3a29fe9f76733",
  }),
});
export const referralGraphIds = Object.freeze([
  "977e908c362e2b27", "8fe574816fd8bfd7", "1358345fa93a89b0", "f96b90a57be61a5c", "e0626c2a0b415f70",
]);
export const referralRouteHash = "f97bfb153da80d0ce18da6de04923461ab9cb95ebf51c92acfe5066fb4ab62a8";
export const referralGraphHash = "dd1f77a3138a157e34972de7b921199a510489e6ded1d4296d2497f71edf17b2";

// Pure edit description: it contains no business/auth text. Application admission is
// separately fenced by the immutable source, candidate, route and scoped graph hashes.
export function referralObserverEdits(stage, sourceHash) {
  if (!["purchase_prepare", "owner_resolve"].includes(stage) || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("DIAGNOSTIC_SCOPE_INVALID");
  const prefix = `// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "${stage}", { sourceHash: "${sourceHash}", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
` + (stage === "purchase_prepare"
    ? 'lkDiagnostic({ code: "STAGE_ENTER" });\n'
    : 'try { if (typeof global !== "undefined") global.get("lkDiagnostics")?.upstream(msg, msg._referralSubscriptionCtx?.step || "owner_resolve"); } catch { /* no-throw */ }\n');
  return { prefix, needle: "const fail = (status, error, details) => {\n",
    addition: '  lkDiagnostic({ code: "UPSTREAM_REFUSED", httpStatus: status, reason: details?.code, outcome: "refused" });\n' };
}

export function instrumentReferralFunction(source, stage) {
  if (typeof source !== "string") throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
  const { prefix, needle, addition } = referralObserverEdits(stage, sha(source));
  if (source.split(needle).length !== 2 || source.includes("const lkDiagnostic =")) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
  return prefix + source.replace(needle, needle + addition);
}

export function scopedReferralGraphHash(flow) {
  const rows = referralGraphIds.map(id => {
    const matches = flow.filter(node => node.id === id);
    if (matches.length !== 1) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
    const node = matches[0];
    return { id, type: node.type, z: node.z ?? null, outputs: node.outputs ?? null,
      wires: node.wires ?? [], disabled: node.disabled === true };
  });
  return sha(JSON.stringify(rows));
}

export function assertCurrentReferralBinding(flow, attestation, sourceHash) {
  const binding = referralObserverBindings[attestation.path];
  const tab = flow.filter(node => node.id === "ac5d37d8ebd616ca");
  if (!Object.hasOwn(referralObserverBindings, attestation.path) || attestation.id !== binding.id || attestation.routeId !== referralGraphIds[0]
    || attestation.routeHash !== referralRouteHash || tab.length !== 1 || tab[0].type !== "tab" || tab[0].disabled === true
    || attestation.preimageHash !== binding.preimageHash || sourceHash !== binding.preimageHash
    || attestation.candidateHash !== binding.candidateHash || scopedReferralGraphHash(flow) !== referralGraphHash) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
}

export function applyCurrentReferralObserver(flow, attestation, source) {
  if (typeof source !== "string") throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
  assertCurrentReferralBinding(flow, attestation, sha(source));
  const binding = referralObserverBindings[attestation.path];
  const candidate = instrumentReferralFunction(source, binding.stage);
  if (sha(candidate) !== binding.candidateHash) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
  return candidate;
}
