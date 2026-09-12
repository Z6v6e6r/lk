#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) fail(`${label} fields do not match the approved schema`);
};
const exactArray = (value, expected, label) => {
  if (!isDeepStrictEqual(value, expected)) fail(`${label} differs from the approved fail-closed policy`);
};
export const checkedPartnerProductionControls = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./partner_game_membership_production_controls.json", import.meta.url),
  "utf8",
)));

export function validatePartnerProductionControls(contract) {
  exactKeys(contract, [
    "formatVersion", "deploymentId", "environment", "contractState", "executionAuthorized",
    "productionMutationAllowed", "runtime", "ingress", "custody", "activation",
  ], "Partner production controls");
  if (contract.formatVersion !== 1
    || contract.deploymentId !== "partner-game-membership-api-v02"
    || contract.environment !== "PRODUCTION"
    || contract.contractState !== "UNBOUND"
    || contract.executionAuthorized !== false
    || contract.productionMutationAllowed !== false) {
    fail("Partner production controls must remain unbound and non-executable");
  }

  const runtime = contract.runtime;
  exactKeys(runtime, [
    "state", "requiredNodeVersion", "minimumRehearsedNodeRedVersion", "exactNodeRedVersionRequired",
    "compatibilityRehearsalRequired", "securityAuditRequired", "immutableClosure", "sidecar", "auditPolicy",
    "latestIsolatedRehearsal", "binding",
  ], "Partner runtime controls");
  if (runtime.state !== "SECURITY_AUDIT_PASS"
    || runtime.requiredNodeVersion !== "22.23.2"
    || runtime.minimumRehearsedNodeRedVersion !== "5.0.6"
    || runtime.exactNodeRedVersionRequired !== true
    || runtime.compatibilityRehearsalRequired !== true
    || runtime.securityAuditRequired !== true) {
    fail("Partner runtime must remain pinned to the rehearsed floor and audit-blocked");
  }
  exactKeys(runtime.immutableClosure, [
    "runtimeManifestSha256", "packageJsonSha256", "packageLockSha256", "dependencyTreeSha256",
    "auditReportSha256", "functionalRehearsalSha256", "functionalRehearsalCapturedAt",
    "auditCapturedAt", "dependencyTreeCapturedAt", "npmCiInstalledPackageCount",
    "npmLsPackageOccurrenceCount", "npmLsInvalidPackageCount", "npmLsExtraneousPackageCount",
    "productionInstallCommand",
  ], "Partner immutable runtime closure");
  if (!isDeepStrictEqual(runtime.immutableClosure, {
    runtimeManifestSha256: "7a789a6308e10f11b22f0ca9d5979435ebda6ad65bd510f3002c629bd8f3bb91",
    packageJsonSha256: "929ee0bf50f453284c4e619e4cbd698c204a41119d15a84e701e04d58b27c7d4",
    packageLockSha256: "c3ac8470995c68660ff4d55744b276f6d172b802a20fdcb9e7263a16fb3690e5",
    dependencyTreeSha256: "b90abb8c6780e42caae6cc06db42f6ed7b5877d5b173239b34603048398a99c2",
    auditReportSha256: "f984affcc6600ead898038a0f6143d2e032c0c659441b1bc03b983b9acb3e8e7",
    functionalRehearsalSha256: "fed34bc90e9e536d12bd58d84cbcf78ca7eaa75389849e2dce809dd273ebeb7d",
    functionalRehearsalCapturedAt: "2026-09-12T06:26:07.247Z",
    auditCapturedAt: "2026-09-11T12:00:11.196Z",
    dependencyTreeCapturedAt: "2026-09-11T12:00:08.539Z",
    npmCiInstalledPackageCount: 291,
    npmLsPackageOccurrenceCount: 838,
    npmLsInvalidPackageCount: 0,
    npmLsExtraneousPackageCount: 0,
    productionInstallCommand: "npm ci --ignore-scripts --no-fund --no-audit",
  })) fail("Partner immutable runtime closure identity changed");
  exactKeys(runtime.sidecar, ["topology","bindAddress","port","settingsSha256","serviceUnitSha256","settingsRuntimeSha256","settingsGuardedSha256","guardedStartupSha256","rawRequestGuardSha256","rawAuditSha256","guardedPolicySha256","candidateFlowSha256","rehearsalSha256","rehearsalCapturedAt","sharedFlowMutationAllowed"], "Partner sidecar closure");
  if (!isDeepStrictEqual(runtime.sidecar, {
    topology: "DEDICATED_LOOPBACK_SIDECAR",
    bindAddress: "127.0.0.1",
    port: 18894,
    settingsSha256: "37e675a39f12d2a23352578cd7f1068e0b5ae1d3d92649e5078f0050a6448e3d",
    serviceUnitSha256: "3abbb557f2be9565ff115436107de08e4d8f0e566179700eb47bb1a1a01503dc",
    settingsRuntimeSha256: "cabd3d1867311ae0bfa8165687d7911ebc60a0e84f54959192dacfead67451c1",
    settingsGuardedSha256: "1ad5eeaf32ddb703b12f88c31151ff7b7fe9960a55a61a5433000ca92b24ee49",
    guardedStartupSha256: "4c4248f9ac3e849ffde03e9e23353e5f573fc78bb3200a2fa5547617ecbf0582",
    rawRequestGuardSha256: "74437f13a36fe583f6265553a6d06b8e7a91b0abae06ca755c335080c4368871",
    rawAuditSha256: "a89b4d36d49f8f06e8163368b3e7c4d7a774d494100748fce1a25bdc7884eead",
    guardedPolicySha256: "abd5f0aefda8cc83570ac9c202bfac65717fe6546a158861b2beaf0c50db2a40",
    candidateFlowSha256: "5a5aefe3dd19a8e6687222c80b229a40f924174359c181be7caaa6997134e965",
    rehearsalSha256: "d612cf7b0ef2ac0af11e43ed596753295a90b3ec96730d34d98cf618274019fb",
    rehearsalCapturedAt: "2026-09-12T07:42:54.634Z",
    sharedFlowMutationAllowed: false,
  })) fail("Partner sidecar immutable closure identity changed");
  exactKeys(runtime.auditPolicy, [
    "maxAgeHours", "criticalAffectedPackages", "highReachablePackages",
    "partnerRequestSurfaceDecisionRequired", "editorAdminExposureAllowed", "unresolvedAuditAllowed",
  ], "Partner runtime audit policy");
  if (runtime.auditPolicy.maxAgeHours !== 24
    || runtime.auditPolicy.criticalAffectedPackages !== 0
    || runtime.auditPolicy.highReachablePackages !== 0
    || runtime.auditPolicy.partnerRequestSurfaceDecisionRequired !== true
    || runtime.auditPolicy.editorAdminExposureAllowed !== false
    || runtime.auditPolicy.unresolvedAuditAllowed !== false) {
    fail("Partner runtime audit policy was weakened");
  }
  const rehearsal = runtime.latestIsolatedRehearsal;
  exactKeys(rehearsal, [
    "evidenceScope", "functionalRehearsalSha256", "capturedAt",
    "sourceCommit", "nodeImageSha256", "nodeVersion", "nodeRedVersion", "customNodeReleaseSha256",
    "defaultOffHttpStatus", "flowRollbackHttpStatus", "packageRollbackHttpStatus",
    "flowPartnerMatchesAfterRollback", "palettePartnerMatchesAfterRollback", "corsResponseHeaderObserved",
    "auditAffectedPackages", "auditDecision", "productionTouched",
  ], "Partner isolated runtime rehearsal");
  exactKeys(rehearsal.auditAffectedPackages, [
    "critical", "high", "moderate", "low", "total",
  ], "Partner isolated runtime audit counts");
  const counts = rehearsal.auditAffectedPackages;
  if (rehearsal.evidenceScope !== "CUSTOM_NODE_LOAD_DEFAULT_OFF_AND_REMOVAL_COMPATIBILITY_ONLY"
    || rehearsal.functionalRehearsalSha256 !== runtime.immutableClosure.functionalRehearsalSha256
    || rehearsal.capturedAt !== runtime.immutableClosure.functionalRehearsalCapturedAt
    || rehearsal.sourceCommit !== "aaca89270d1ac3a8d8adc622226026df6f9c32ef"
    || rehearsal.nodeImageSha256 !== "83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5"
    || rehearsal.nodeVersion !== runtime.requiredNodeVersion
    || rehearsal.nodeRedVersion !== runtime.minimumRehearsedNodeRedVersion
    || rehearsal.customNodeReleaseSha256 !== "15361530654e2f4f0f20d83481991bc2402a3ccc0e47cef95b1729b305ab77f4"
    || rehearsal.defaultOffHttpStatus !== 503
    || rehearsal.flowRollbackHttpStatus !== 404
    || rehearsal.packageRollbackHttpStatus !== 404
    || rehearsal.flowPartnerMatchesAfterRollback !== 0
    || rehearsal.palettePartnerMatchesAfterRollback !== 0
    || rehearsal.corsResponseHeaderObserved !== null
    || ![counts.critical, counts.high, counts.moderate, counts.low, counts.total]
      .every((value) => Number.isInteger(value) && value >= 0)
    || counts.total !== counts.critical + counts.high + counts.moderate + counts.low
    || !isDeepStrictEqual(counts, { critical: 0, high: 0, moderate: 7, low: 0, total: 7 })
    || rehearsal.auditDecision !== "PASS_NO_CRITICAL_OR_HIGH_AFFECTED_PACKAGES"
    || rehearsal.productionTouched !== false) {
    fail("Partner isolated runtime rehearsal evidence is incomplete or overclaims remediation");
  }
  exactKeys(runtime.binding, [
    "exactNodeRedVersion", "auditCapturedAt", "auditReportSha256", "criticalAffectedPackages",
    "highAffectedPackages", "moderateAffectedPackages", "lowAffectedPackages", "reachablePackages",
    "decisionRecord",
  ], "Partner runtime binding");
  if (!isDeepStrictEqual(runtime.binding, {
    exactNodeRedVersion: null,
    auditCapturedAt: null,
    auditReportSha256: null,
    criticalAffectedPackages: null,
    highAffectedPackages: null,
    moderateAffectedPackages: null,
    lowAffectedPackages: null,
    reachablePackages: [],
    decisionRecord: null,
  })) fail("Partner production runtime binding must remain empty");

  const ingress = contract.ingress;
  exactKeys(ingress, ["state", "routing", "transport", "requestPolicy", "responsePolicy", "binding"], "Partner ingress controls");
  if (ingress.state !== "UNBOUND") fail("Partner ingress must remain unbound");
  exactKeys(ingress.routing, [
    "exactHost", "upstream", "exclusiveIngressRequired", "alternateHostnameAccessAllowed",
    "directNodeRedAccessAllowed", "hostHeaderMustMatchExactHost", "sniMustMatchExactHost",
    "routes", "queryAllowed", "otherMethodsAllowed", "editorAdminSurfaceAllowed", "corsAllowed",
    "optionsAllowed", "proxyRetries", "requiredNegativeReadback",
  ], "Partner ingress routing");
  const expectedRoutes = [
    { method: "POST", path: "/lk/integrations/v1/open-games/:gameId/members" },
    { method: "DELETE", path: "/lk/integrations/v1/open-games/:gameId/members/:membershipId" },
    { method: "GET", path: "/lk/integrations/v1/operations/:operationId" },
  ];
  if (ingress.routing.exactHost !== null
    || ingress.routing.upstream !== "http://127.0.0.1:18894"
    || ingress.routing.exclusiveIngressRequired !== true
    || ingress.routing.alternateHostnameAccessAllowed !== false
    || ingress.routing.directNodeRedAccessAllowed !== false
    || ingress.routing.hostHeaderMustMatchExactHost !== true
    || ingress.routing.sniMustMatchExactHost !== true
    || !isDeepStrictEqual(ingress.routing.routes, expectedRoutes)
    || ingress.routing.queryAllowed !== false
    || ingress.routing.otherMethodsAllowed !== false
    || ingress.routing.editorAdminSurfaceAllowed !== false
    || ingress.routing.corsAllowed !== false
    || ingress.routing.optionsAllowed !== false
    || ingress.routing.proxyRetries !== 0
    || !isDeepStrictEqual(ingress.routing.requiredNegativeReadback, [
      "WRONG_HOST_REJECTED",
      "WRONG_SNI_REJECTED",
      "SHARED_HOST_ROUTES_404",
      "DIRECT_NODE_RED_CONNECTION_REFUSED",
    ])) {
    fail("Partner ingress routing is widened or bound without approval");
  }
  exactKeys(ingress.transport, [
    "minimumTlsVersion", "requiredClientIdentity", "cidrOnlyFallbackAllowed", "boundClientIdentity",
    "allowedSourceCidrs", "certificateSpkiSha256", "trustedProxyCidrs", "trustedProxyHopCount",
    "socketPeerAllowlistRequired", "stripInboundForwardedHeaders", "overwriteForwardedHeadersFromSocketPeer",
  ], "Partner ingress transport");
  if (ingress.transport.minimumTlsVersion !== "TLSv1.2"
    || ingress.transport.requiredClientIdentity !== "MTLS"
    || ingress.transport.cidrOnlyFallbackAllowed !== false
    || ingress.transport.boundClientIdentity !== null
    || !isDeepStrictEqual(ingress.transport.allowedSourceCidrs, [])
    || ingress.transport.certificateSpkiSha256 !== null
    || !isDeepStrictEqual(ingress.transport.trustedProxyCidrs, [])
    || ingress.transport.trustedProxyHopCount !== null
    || ingress.transport.socketPeerAllowlistRequired !== true
    || ingress.transport.stripInboundForwardedHeaders !== true
    || ingress.transport.overwriteForwardedHeadersFromSocketPeer !== true) {
    fail("Partner ingress transport must remain least-privilege and unbound");
  }
  exactKeys(ingress.requestPolicy, [
    "allowedContentTypes", "maxBodyBytes", "maxRequestLineBytes", "maxHeaderBytes",
    "maxConcurrentPerClient", "maxConcurrentPerSource", "requestsPerSecondPerClient", "burstPerClient",
    "requestsPerSecondPerSource", "burstPerSource", "upstreamTimeoutSeconds",
    "duplicateCriticalHeadersRejected", "duplicateJsonKeysRejected", "criticalHeaders", "preserveRawPath",
    "preserveCanonicalJsonSemantics",
  ], "Partner ingress request policy");
  exactArray(ingress.requestPolicy.allowedContentTypes, ["application/json"], "Partner content type allowlist");
  exactArray(ingress.requestPolicy.criticalHeaders, [
    "content-type", "x-padlhub-client-id", "x-padlhub-audience", "x-padlhub-key-id", "x-padlhub-timestamp",
    "x-padlhub-nonce", "idempotency-key", "x-correlation-id", "x-padlhub-signature",
  ], "Partner critical header allowlist");
  if (ingress.requestPolicy.maxBodyBytes !== 16384
    || ingress.requestPolicy.maxRequestLineBytes !== 2048
    || ingress.requestPolicy.maxHeaderBytes !== 16384
    || ingress.requestPolicy.maxConcurrentPerClient !== 4
    || ingress.requestPolicy.maxConcurrentPerSource !== 8
    || ingress.requestPolicy.requestsPerSecondPerClient !== 2
    || ingress.requestPolicy.burstPerClient !== 10
    || ingress.requestPolicy.requestsPerSecondPerSource !== 5
    || ingress.requestPolicy.burstPerSource !== 20
    || ingress.requestPolicy.upstreamTimeoutSeconds !== 15
    || ingress.requestPolicy.duplicateCriticalHeadersRejected !== true
    || ingress.requestPolicy.duplicateJsonKeysRejected !== true
    || ingress.requestPolicy.preserveRawPath !== true
    || ingress.requestPolicy.preserveCanonicalJsonSemantics !== true) {
    fail("Partner ingress request limits or signature-preservation rules changed");
  }
  exactKeys(ingress.responsePolicy, [
    "cacheControl", "hideUpstreamHeaders", "accessLogsRedacted", "requestBodyLogged", "securityHeadersLogged",
  ], "Partner ingress response policy");
  exactArray(ingress.responsePolicy.hideUpstreamHeaders, ["Access-Control-Allow-Origin"], "Partner hidden upstream headers");
  if (ingress.responsePolicy.cacheControl !== "no-store"
    || ingress.responsePolicy.accessLogsRedacted !== true
    || ingress.responsePolicy.requestBodyLogged !== false
    || ingress.responsePolicy.securityHeadersLogged !== false) {
    fail("Partner ingress response or logging policy was weakened");
  }
  exactKeys(ingress.binding, [
    "configPath", "configSha256", "owner", "approvedAt", "rehearsedAt", "readbackSha256",
  ], "Partner ingress binding");
  if (Object.values(ingress.binding).some((value) => value !== null)) {
    fail("Partner ingress binding must remain empty");
  }

  const custody = contract.custody;
  exactKeys(custody, [
    "state", "packetClassification", "partnerPacketTransferAllowed", "allowedPacketRecipients",
    "transferChannel", "targetHostAlias", "targetDirectory", "directoryMode", "fileMode",
    "symlinksAllowed", "retentionUntil", "custodyOwner", "deletionOwner", "incidentOwner",
    "credentialChangesAuthorized", "credentialValidationAllowed", "testProductionClientIdReuseAllowed",
    "testProductionHmacKeyReuseAllowed", "testProductionCertificateReuseAllowed",
    "testProductionAudienceReuseAllowed", "disclosedCredentialHandling", "secretValuesInRepositoryAllowed",
  ], "Partner packet custody");
  if (custody.state !== "UNBOUND"
    || custody.packetClassification !== "SECRET_BEARING"
    || custody.partnerPacketTransferAllowed !== false
    || !isDeepStrictEqual(custody.allowedPacketRecipients, [])
    || custody.transferChannel !== null
    || custody.targetHostAlias !== null
    || custody.targetDirectory !== null
    || custody.directoryMode !== "0700"
    || custody.fileMode !== "0600"
    || custody.symlinksAllowed !== false
    || custody.retentionUntil !== null
    || custody.custodyOwner !== null
    || custody.deletionOwner !== null
    || custody.incidentOwner !== null
    || custody.credentialChangesAuthorized !== false
    || custody.credentialValidationAllowed !== false
    || custody.testProductionClientIdReuseAllowed !== false
    || custody.testProductionHmacKeyReuseAllowed !== false
    || custody.testProductionCertificateReuseAllowed !== false
    || custody.testProductionAudienceReuseAllowed !== false
    || custody.disclosedCredentialHandling !== "DO_NOT_DISPLAY_COPY_EXPORT_VALIDATE_OR_CHANGE"
    || custody.secretValuesInRepositoryAllowed !== false) {
    fail("Partner packet custody is bound, widened, or authorizes credential handling");
  }

  const activation = contract.activation;
  exactKeys(activation, [
    "state", "deployAuthorized", "ingressMutationAuthorized", "secretProvisioningAuthorized",
    "flowImportAuthorized", "nodeRedRestartAuthorized", "globalApiEnabled", "providerMode",
    "vivaMutationsEnabled", "canaryClientId", "canaryGameIds", "requiredExternalEvidence",
  ], "Partner activation controls");
  const expectedExternalEvidence = [
    "written Viva sidecar token grant, refresh, revocation, idempotency, ON_PLACE, create, read-back, and cancel contract",
    "bound ingress identity, TLS, route, limit, and trusted-proxy read-back",
    "bound packet and server-only secret custody with named owners and distinct test/production client IDs, audiences, HMAC keys, and certificates",
    "fresh runtime audit with no unresolved partner-reachable critical or high advisory",
    "production Mongo replica, exact indexes, backup, rollback, and reconciliation ownership",
    "separate authorization for deploy and separate authorization for activation",
  ];
  if (activation.state !== "BLOCKED"
    || activation.deployAuthorized !== false
    || activation.ingressMutationAuthorized !== false
    || activation.secretProvisioningAuthorized !== false
    || activation.flowImportAuthorized !== false
    || activation.nodeRedRestartAuthorized !== false
    || activation.globalApiEnabled !== false
    || activation.providerMode !== "disabled"
    || activation.vivaMutationsEnabled !== false
    || activation.canaryClientId !== null
    || !isDeepStrictEqual(activation.canaryGameIds, [])
    || !isDeepStrictEqual(activation.requiredExternalEvidence, expectedExternalEvidence)) {
    fail("Partner deploy or activation boundary was widened");
  }
  const serialized = JSON.stringify(contract);
  if (/mongodb(?:\+srv)?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+/i.test(serialized)) {
    fail("Partner production controls contain a credential-shaped value");
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validatePartnerProductionControls(checkedPartnerProductionControls);
  process.stdout.write("PARTNER_PRODUCTION_CONTROLS=UNBOUND_AUDIT_PASS\n");
}
