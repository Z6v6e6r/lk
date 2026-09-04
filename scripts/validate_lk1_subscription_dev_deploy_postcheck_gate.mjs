#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkedProvisioningContract,
  validateDevProvisioningContract,
} from "./validate_lk1_subscription_dev_provisioning_contract.mjs";
import {
  CHECKED_DEV_CANDIDATE_BINDING,
  CHECKED_DEV_SOURCE_AUTHORIZATION,
  LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  validateDevBinding,
  validateDevSourceAuthorization,
} from "./prepare_lk1_subscription_dev_candidate.mjs";
import { validateRuntimeInstallContract } from "./verify_lk1_subscription_dev_runtime_install_candidate.mjs";
import { validateReleaseReceiptV2 } from "./validate_lk1_subscription_dev_release_receipt_v2.mjs";
import {
  checkedHostPreflightEvidence,
  validateHostPreflightEvidence,
} from "./validate_lk1_subscription_dev_host_preflight.mjs";

const readJson = (relativePath) => JSON.parse(fs.readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8",
));
const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema mismatch`);
  }
};
const exactArray = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch`);
};

export const checkedDeployPostcheckGate = Object.freeze(readJson(
  "./lk1_subscription_dev_deploy_postcheck_gate_contract.json",
));
const checkedRuntimeInstallContract = Object.freeze(readJson(
  "./lk1_subscription_dev_runtime_install_contract.json",
));
const checkedReleaseReceipt = Object.freeze(readJson(
  "./lk1_subscription_dev_release_receipt_v2_contract.json",
));

const PREDEPLOY_CHECKS = Object.freeze([
  "FROZEN_REPOSITORY_IDENTITY",
  "IMMUTABLE_CANDIDATE_VERIFIED",
  "CURRENT_HOST_IDENTITY",
  "AUTHORIZATION_TRANSPORT_SUPPORTED",
  "DEDICATED_UNITS_DISABLED_INACTIVE",
  "RESERVED_LISTENERS_ABSENT",
  "AUTHORIZATION_INPUTS_ABSENT",
  "SHARED_RESOURCES_UNCHANGED",
  "PRODUCTION_ROUTES_ORIGINS_ABSENT",
  "ROLLBACK_TO_ABSENT_REVIEWED",
]);
const POSTCHECK_PHASES = Object.freeze([
  Object.freeze({
    id: "INSTALLED_STOPPED",
    checks: [
      "HOST_READBACK_DIGEST_MATCH",
      "UNITS_DISABLED_INACTIVE",
      "LISTENERS_ABSENT",
      "SHARED_RESOURCES_UNCHANGED",
    ],
  }),
  Object.freeze({
    id: "STARTED_DEFAULT_OFF",
    checks: [
      "EXACT_SERVICE_IDENTITIES",
      "LOOPBACK_LISTENER_OWNERSHIP",
      "ROUTE_AND_GRAPH_HEALTH",
      "PRODUCTION_CONNECTIONS_ZERO",
      "IDLE_WRITES_ZERO",
    ],
  }),
  Object.freeze({
    id: "CANARY_ACTIVE",
    checks: [
      "EXACT_TWO_SERVER_OWNED_CANARIES",
      "THIRD_SUBSCRIPTION_BYPASSES_MANAGED_PATH",
      "CONTROL_SUBSCRIPTION_REQUIRED",
      "NO_PRODUCTION_CONNECTIONS",
      "EXPECTED_FIXTURE_DELTAS_ONLY",
    ],
  }),
  Object.freeze({
    id: "ROLLBACK_TO_ABSENT",
    checks: [
      "INGRESS_REMOVED_BEFORE_LISTENER",
      "EXACT_SERVICE_STOP_ORDER",
      "UNITS_DISABLED_INACTIVE",
      "LISTENERS_ABSENT",
      "SHARED_RESOURCES_UNCHANGED",
      "EVIDENCE_LOGS_PRESERVED",
      "DATA_DELETION_ZERO",
      "ABSENT_PREIMAGE_RESTORED",
    ],
  }),
]);
const ZERO_COUNTERS = Object.freeze([
  "productionDnsResolutions",
  "productionTcpConnections",
  "productionTlsConnections",
  "productionHttpRequests",
  "productionMongoWrites",
  "productionVivaWrites",
  "productionCupWrites",
  "productionPaymentWrites",
]);

export function validateDeployPostcheckGate(gate, {
  provisioningContract = checkedProvisioningContract,
  runtimeInstallContract = checkedRuntimeInstallContract,
  releaseReceipt = checkedReleaseReceipt,
  runtimeEnvironmentBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  candidateBinding = CHECKED_DEV_CANDIDATE_BINDING,
  sourceAuthorization = CHECKED_DEV_SOURCE_AUTHORIZATION,
  hostPreflightEvidence = checkedHostPreflightEvidence,
  now = new Date(),
} = {}) {
  validateDevProvisioningContract(provisioningContract);
  validateRuntimeInstallContract(runtimeInstallContract);
  validateReleaseReceiptV2(releaseReceipt);
  validateDevBinding(candidateBinding, runtimeEnvironmentBindings, provisioningContract);
  validateDevSourceAuthorization(sourceAuthorization, candidateBinding, {
    candidateSha256: releaseReceipt.candidateSha256,
    manifestSha256: releaseReceipt.manifestSha256,
  });
  validateHostPreflightEvidence(hostPreflightEvidence, now);

  exactKeys(gate, [
    "schemaVersion", "environment", "state", "productionBindingState", "releaseBinding",
    "target", "runtimeBinding", "productionIsolation", "predeploy", "postcheck",
    "canaryActivation", "rollback", "blockers", "authority", "claims",
  ], "DEV deploy/post-check gate");
  if (gate.schemaVersion !== 1 || gate.environment !== "DEV"
    || gate.state !== "PREPARED_SOURCE_ONLY_READY_FOR_STOPPED_INSTALL_REVIEW"
    || gate.productionBindingState !== "UNBOUND_AFTER_ROUTER_AMENDMENT") {
    fail("DEV deploy/post-check gate identity mismatch");
  }

  exactKeys(gate.releaseBinding, [
    "sourceCommit", "sourceFlowSha256", "candidateSha256", "manifestSha256",
  ], "DEV release binding");
  for (const field of ["sourceCommit", "sourceFlowSha256", "candidateSha256", "manifestSha256"]) {
    if (gate.releaseBinding[field] !== releaseReceipt[field]) {
      fail(`DEV deploy/post-check gate release binding drift (${field})`);
    }
  }
  if (gate.releaseBinding.sourceCommit !== sourceAuthorization.sourceCommit
    || gate.releaseBinding.sourceCommit !== candidateBinding.source.sourceCommit
    || gate.releaseBinding.sourceFlowSha256 !== sourceAuthorization.sourceSha256
    || gate.releaseBinding.sourceFlowSha256 !== candidateBinding.source.sourceSha256
    || gate.releaseBinding.candidateSha256 !== sourceAuthorization.candidateSha256
    || gate.releaseBinding.manifestSha256 !== sourceAuthorization.manifestSha256) {
    fail("DEV deploy/post-check gate is not bound to the authorized candidate source identity");
  }

  exactKeys(gate.target, [
    "hostAlias", "serviceName", "unixUser", "flowPath", "listener", "fixtureListeners",
    "ingressState",
  ], "DEV deploy target");
  const plannedTarget = provisioningContract.plannedTarget;
  const fixtureDependencies = provisioningContract.fixtureDependencies;
  const expectedFixtureListeners = [
    `${fixtureDependencies.mongo.host}:${fixtureDependencies.mongo.port}`,
    fixtureDependencies.cup.listener,
    fixtureDependencies.provider.listener,
    fixtureDependencies.identity.listener,
  ];
  if (gate.target.hostAlias !== releaseReceipt.target.hostAlias
    || gate.target.serviceName !== releaseReceipt.target.serviceName
    || gate.target.serviceName !== plannedTarget.serviceName
    || gate.target.unixUser !== plannedTarget.unixUser
    || gate.target.flowPath !== releaseReceipt.target.flowPath
    || gate.target.flowPath !== runtimeInstallContract.target.nodeRedFlowPath
    || gate.target.listener !== `${plannedTarget.listener.host}:${plannedTarget.listener.port}`
    || gate.target.ingressState !== "UNBOUND") {
    fail("DEV deploy target is not the exact isolated stopped target");
  }
  exactArray(gate.target.fixtureListeners, expectedFixtureListeners, "DEV fixture listeners");

  exactKeys(gate.runtimeBinding, [
    "state", "candidateCupApiBase", "dedicatedCupListener", "cupMatchesDedicatedListener",
    "candidateMongo", "provisionedMongo", "mongoMatchesProvisionedDatabase",
    "completeManagedContractSourceImplemented", "localPhysicalVerified", "hostRuntimeExposed",
    "completeManagedContractExposed",
  ], "DEV runtime binding");
  exactKeys(gate.runtimeBinding.candidateMongo, [
    "host", "port", "database", "replicaSet", "credentialFree",
  ], "DEV candidate Mongo identity");
  exactKeys(gate.runtimeBinding.provisionedMongo, [
    "host", "port", "database",
  ], "DEV provisioned Mongo identity");
  const candidateCupUrl = new URL(runtimeEnvironmentBindings.DEV_ENDPOINTS?.cupApiBase || "invalid:");
  const candidateCupListener = `${candidateCupUrl.hostname}:${candidateCupUrl.port}`;
  const dedicatedCupListener = fixtureDependencies.cup.listener;
  const candidateMongo = runtimeEnvironmentBindings.DEV_MONGO;
  const candidateMongoEvidence = candidateBinding.dependencies?.managedMongoClient?.effectiveIdentity;
  const provisionedMongo = fixtureDependencies.mongo;
  if (runtimeEnvironmentBindings.DEV_CANDIDATE_API_BASE
      !== runtimeEnvironmentBindings.DEV_ENDPOINTS?.cupApiBase
    || candidateBinding.runtime?.apiBase !== runtimeEnvironmentBindings.DEV_CANDIDATE_API_BASE
    || candidateBinding.runtime?.completeManagedContractSourceImplemented !== true
    || candidateBinding.runtime?.localPhysicalVerified !== true
    || candidateBinding.runtime?.hostRuntimeExposed !== false
    || candidateBinding.runtime?.completeManagedContractExposed !== false
    || candidateCupListener === provisioningContract.forbiddenExistingResources.subscriptionShadowListener
    || candidateCupListener !== dedicatedCupListener
    || gate.runtimeBinding.state !== "SOURCE_READY_HOST_RUNTIME_NOT_RUN"
    || gate.runtimeBinding.candidateCupApiBase !== candidateBinding.runtime.apiBase
    || gate.runtimeBinding.dedicatedCupListener !== dedicatedCupListener
    || gate.runtimeBinding.cupMatchesDedicatedListener !== true
    || JSON.stringify(gate.runtimeBinding.candidateMongo) !== JSON.stringify(candidateMongo)
    || candidateMongoEvidence?.host !== candidateMongo.host
    || candidateMongoEvidence?.port !== candidateMongo.port
    || candidateMongoEvidence?.database !== candidateMongo.database
    || candidateMongoEvidence?.credentialsPresent !== false
    || candidateMongoEvidence?.optionsPresent !== false
    || JSON.stringify(gate.runtimeBinding.provisionedMongo) !== JSON.stringify({
      host: provisionedMongo.host,
      port: provisionedMongo.port,
      database: provisionedMongo.database,
    })
    || candidateMongo.database !== provisionedMongo.database
    || gate.runtimeBinding.mongoMatchesProvisionedDatabase !== true
    || gate.runtimeBinding.completeManagedContractSourceImplemented !== true
    || gate.runtimeBinding.localPhysicalVerified !== true
    || gate.runtimeBinding.hostRuntimeExposed !== false
    || gate.runtimeBinding.completeManagedContractExposed !== false) {
    fail("DEV candidate runtime identity is not source-ready on the dedicated fixture target");
  }

  exactKeys(gate.productionIsolation, [
    "blockedHostAlias", "productionOriginPolicy", "sharedFlowPath", "sharedNodeRedListener",
    "nonLoopbackEgressAllowed", "productionDnsAllowed", "crossEnvironmentWriteBudget",
  ], "DEV production isolation");
  if (gate.productionIsolation.blockedHostAlias !== "lk-primary-147"
    || gate.productionIsolation.productionOriginPolicy !== "DENY_ALL"
    || gate.productionIsolation.sharedFlowPath !== provisioningContract.forbiddenExistingResources.flowPath
    || gate.productionIsolation.sharedNodeRedListener
      !== provisioningContract.forbiddenExistingResources.nodeRedListener
    || gate.productionIsolation.nonLoopbackEgressAllowed !== false
    || gate.productionIsolation.productionDnsAllowed !== false
    || gate.productionIsolation.crossEnvironmentWriteBudget !== 0) {
    fail("DEV production isolation is not fail-closed");
  }

  exactKeys(gate.predeploy, [
    "state", "freshEvidenceRequired", "capturedAt", "maximumAgeSeconds",
    "mustRefreshImmediatelyBeforeInstall", "checks",
  ], "DEV predeploy gate");
  if (gate.predeploy.state !== "PASS_AT_CAPTURE" || gate.predeploy.freshEvidenceRequired !== true
    || gate.predeploy.capturedAt !== hostPreflightEvidence.capturedAt
    || gate.predeploy.maximumAgeSeconds !== hostPreflightEvidence.maximumAgeSeconds
    || gate.predeploy.mustRefreshImmediatelyBeforeInstall !== true) {
    fail("DEV predeploy evidence is absent, stale, or not marked for execution-time refresh");
  }
  exactArray(gate.predeploy.checks, PREDEPLOY_CHECKS, "DEV predeploy checks");

  exactKeys(gate.postcheck, [
    "state", "observationWindowSeconds", "phases", "requiredZeroCounters",
  ], "DEV post-check gate");
  exactKeys(gate.postcheck.observationWindowSeconds, ["minimum", "maximum"], "Observation window");
  if (gate.postcheck.state !== "NOT_RUN"
    || gate.postcheck.observationWindowSeconds.minimum !== 600
    || gate.postcheck.observationWindowSeconds.maximum !== 900
    || !Array.isArray(gate.postcheck.phases)
    || gate.postcheck.phases.length !== POSTCHECK_PHASES.length) {
    fail("DEV post-check plan is incomplete or claims runtime evidence");
  }
  gate.postcheck.phases.forEach((phase, index) => {
    exactKeys(phase, ["id", "state", "requiresSeparateAuthorization", "checks"], `Post-check phase ${index}`);
    const expected = POSTCHECK_PHASES[index];
    if (phase.id !== expected.id || phase.state !== "NOT_RUN"
      || phase.requiresSeparateAuthorization !== true) {
      fail(`Post-check phase authority mismatch (${expected.id})`);
    }
    exactArray(phase.checks, expected.checks, `Post-check phase checks (${expected.id})`);
  });
  exactArray(gate.postcheck.requiredZeroCounters, ZERO_COUNTERS, "DEV zero-write counters");

  exactKeys(gate.canaryActivation, [
    "state", "identifierType", "exactCount", "valuesIncluded", "defaultOff",
    "controlSubscriptionRequired",
  ], "DEV canary activation");
  if (gate.canaryActivation.state !== "NOT_CONFIGURED"
    || gate.canaryActivation.identifierType !== "CLIENT_SUBSCRIPTION_ID_OR_STABLE_HMAC"
    || gate.canaryActivation.exactCount !== 2
    || gate.canaryActivation.valuesIncluded !== false
    || gate.canaryActivation.defaultOff !== true
    || gate.canaryActivation.controlSubscriptionRequired !== true) {
    fail("DEV canary activation must stay exact-two, server-owned, and default-off");
  }

  exactKeys(gate.rollback, [
    "state", "mode", "failurePolicy", "triggers", "serviceStopOrder",
    "removeIngressBeforeListener", "preserveEvidenceAndLogs", "deleteData",
    "requiresSeparateAuthorization",
  ], "DEV rollback gate");
  exactArray(gate.rollback.triggers, [
    "HOST_READBACK_MISMATCH",
    "UNEXPECTED_LISTENER_OR_OWNER",
    "PRODUCTION_CONNECTION_OR_WRITE",
    "NONZERO_UNEXPECTED_COUNTER",
    "SOAK_HEALTH_FAILURE",
  ], "DEV rollback triggers");
  exactArray(
    gate.rollback.serviceStopOrder,
    provisioningContract.rollback.serviceStopOrder,
    "DEV rollback stop order",
  );
  if (gate.rollback.state !== "NOT_RUN"
    || gate.rollback.mode !== releaseReceipt.rollback.mode
    || gate.rollback.failurePolicy !== "ANY_REQUIRED_CHECK_FAILURE_STOPS"
    || gate.rollback.removeIngressBeforeListener
      !== provisioningContract.rollback.removeIngressBeforeListener
    || gate.rollback.preserveEvidenceAndLogs
      !== provisioningContract.rollback.preserveEvidenceAndLogs
    || gate.rollback.preserveEvidenceAndLogs !== releaseReceipt.rollback.preserveEvidence
    || gate.rollback.deleteData !== false
    || gate.rollback.deleteData !== releaseReceipt.rollback.deleteData
    || gate.rollback.requiresSeparateAuthorization !== true
    || gate.rollback.requiresSeparateAuthorization
      !== releaseReceipt.rollback.requiresSeparateAuthorization) {
    fail("DEV rollback custody or authority mismatch");
  }

  exactArray(gate.blockers, [], "DEV deploy blockers");

  exactKeys(gate.authority, [
    "hostRead", "hostInstall", "daemonReload", "serviceStart", "enableUnits", "ingress",
    "activation", "canaryConfig", "secrets", "externalWrites", "productionOperations",
  ], "DEV gate authority");
  if (Object.values(gate.authority).some((value) => value !== false)) {
    fail("Source-only DEV gate cannot grant external or runtime authority");
  }
  exactKeys(gate.claims, [
    "deploymentPerformed", "postcheckPerformed", "devDeployed", "devActive", "deployable",
  ], "DEV gate claims");
  if (Object.values(gate.claims).some((value) => value !== false)) {
    fail("Source-only DEV gate cannot claim deploy, post-check, or activation evidence");
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) fail("Usage: validate_lk1_subscription_dev_deploy_postcheck_gate.mjs");
  validateDeployPostcheckGate(checkedDeployPostcheckGate);
  process.stdout.write("LK1_DEV_DEPLOY_POSTCHECK_GATE=PREPARED_SOURCE_ONLY_READY_FOR_STOPPED_INSTALL_REVIEW\nDEV_DEPLOYED=NOT_CLAIMED\nDEV_ACTIVE=NOT_CLAIMED\n");
}

export { POSTCHECK_PHASES, PREDEPLOY_CHECKS, ZERO_COUNTERS };
