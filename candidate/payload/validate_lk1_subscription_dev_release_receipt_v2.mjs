const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const exactKeys = (value, keys) => Boolean(value) && typeof value === "object"
  && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const fail = (message) => { throw new Error(message); };

export function validateReleaseReceiptV2(receipt, { requireInstalled = false, requireServed = false } = {}) {
  if (!exactKeys(receipt, [
    "schemaVersion", "environment", "state", "sourceCommit", "sourceFlowSha256",
    "candidateSha256", "manifestSha256", "hostReadbackSha256", "servedSha256",
    "hostPreimage", "rollback", "target", "authority",
  ]) || receipt.schemaVersion !== 2 || receipt.environment !== "DEV"
    || !["SOURCE_ONLY", "INSTALLED_STOPPED", "SERVED"].includes(receipt.state)
    || !COMMIT.test(receipt.sourceCommit || "")
    || ![receipt.sourceFlowSha256, receipt.candidateSha256, receipt.manifestSha256]
      .every((value) => SHA256.test(value || ""))) {
    fail("LK1 DEV release receipt v2 identity mismatch");
  }
  if (!exactKeys(receipt.hostPreimage, ["state", "sha256"])
    || receipt.hostPreimage.state !== "ABSENT" || receipt.hostPreimage.sha256 !== null
    || !exactKeys(receipt.rollback, [
      "mode", "restoreSha256", "preserveEvidence", "deleteData", "requiresSeparateAuthorization",
    ])
    || receipt.rollback.mode !== "RETURN_TO_ABSENT"
    || receipt.rollback.restoreSha256 !== null
    || receipt.rollback.preserveEvidence !== true
    || receipt.rollback.deleteData !== false
    || receipt.rollback.requiresSeparateAuthorization !== true) {
    fail("LK1 DEV release receipt v2 rollback contract mismatch");
  }
  if (!exactKeys(receipt.target, ["hostAlias", "serviceName", "flowPath"])
    || receipt.target.hostAlias !== "lk-reserve-89"
    || receipt.target.serviceName !== "lk1-subscription-dev-nodered.service"
    || receipt.target.flowPath !== "/srv/lk1-subscription-dev/node-red/flows.json"
    || !exactKeys(receipt.authority, ["hostInstall", "serviceStart", "ingress", "activation"])
    || Object.values(receipt.authority).some((value) => value !== false)) {
    fail("LK1 DEV release receipt v2 target or authority mismatch");
  }
  const installed = receipt.state !== "SOURCE_ONLY";
  const served = receipt.state === "SERVED";
  if ((installed && !SHA256.test(receipt.hostReadbackSha256 || ""))
    || (!installed && receipt.hostReadbackSha256 !== null)
    || (served && !SHA256.test(receipt.servedSha256 || ""))
    || (!served && receipt.servedSha256 !== null)
    || (requireInstalled && !installed)
    || (requireServed && !served)) {
    fail("LK1 DEV release receipt v2 state evidence mismatch");
  }
  return true;
}
