// Exact managed JOIN wire parser shared by the receiver's verifier, read and executor.
// This parser never supplies missing authority or mints an entitlement/usage reference.
const managedJoinV2Object = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const managedJoinV2Keys = (value, keys) => managedJoinV2Object(value)
  && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
const managedJoinV2Id = value => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value) && !/[\r\n]/.test(value);
const managedJoinV2Positive = value => Number.isSafeInteger(value) && value > 0;
const managedJoinV2Digest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) && value.length === 71;
const managedJoinV2Entitlement = value => {
  if (!managedJoinV2Keys(value, "subscriptionInstanceId,expectations") || !managedJoinV2Id(value.subscriptionInstanceId)) return null;
  const e = value.expectations;
  if (!managedJoinV2Keys(e, "schemaVersion,policyVersion,policyDigest,targetSnapshot") || e.schemaVersion !== 1
    || !managedJoinV2Positive(e.policyVersion) || !managedJoinV2Digest(e.policyDigest)
    || !managedJoinV2Keys(e.targetSnapshot, "snapshotId,revision,evidenceRef")
    || !managedJoinV2Id(e.targetSnapshot.snapshotId) || !managedJoinV2Positive(e.targetSnapshot.revision)
    || !managedJoinV2Id(e.targetSnapshot.evidenceRef)) return null;
  return { subscriptionInstanceId: value.subscriptionInstanceId, expectations: {
    schemaVersion: 1, policyVersion: e.policyVersion, policyDigest: e.policyDigest,
    targetSnapshot: { snapshotId: e.targetSnapshot.snapshotId, revision: e.targetSnapshot.revision,
      evidenceRef: e.targetSnapshot.evidenceRef }
  } };
};
const managedJoinV2Request = (value, preflight = false) => {
  if (!managedJoinV2Keys(value, preflight ? "contractVersion,action,target,paymentIntent"
    : "contractVersion,action,target,paymentIntent,entitlement") || value.contractVersion !== 2
    || value.action !== "JOIN_GAME" || value.paymentIntent !== "USE_SUBSCRIPTION"
    || !managedJoinV2Keys(value.target, "id,expectedRevision")
    || typeof value.target.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.target.id)
    || !managedJoinV2Positive(value.target.expectedRevision)) return null;
  const entitlement = preflight ? null : managedJoinV2Entitlement(value.entitlement);
  if (!preflight && !entitlement) return null;
  return { contractVersion: 2, action: "JOIN_GAME",
    target: { id: value.target.id, expectedRevision: value.target.expectedRevision },
    paymentIntent: "USE_SUBSCRIPTION", ...(preflight ? {} : { entitlement }) };
};
