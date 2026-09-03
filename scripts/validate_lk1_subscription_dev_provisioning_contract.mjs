#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} fields do not match the approved schema`);
};

export const checkedProvisioningContract = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_provisioning_contract.json", import.meta.url),
  "utf8",
)));

export function validateDevProvisioningContract(contract) {
  exactKeys(contract, [
    "formatVersion", "environment", "contractState", "executionAuthorized", "candidateBuildAllowed",
    "installAllowed", "serviceStartAllowed", "ingressAllowed", "activationAllowed",
    "productionBindingState", "evidence",
    "forbiddenExistingResources", "plannedTarget", "fixtureDependencies",
    "networkPolicy", "runtimeFlags", "releaseIdentity", "ingressAuthorization", "rollback",
  ], "DEV provisioning contract");
  if (contract.formatVersion !== 1 || contract.environment !== "DEV") {
    fail("DEV provisioning environment identity mismatch");
  }
  if (contract.contractState !== "BLOCKED_TARGET_NOT_PROVISIONED"
    || contract.executionAuthorized !== false
    || contract.candidateBuildAllowed !== false
    || contract.installAllowed !== false
    || contract.serviceStartAllowed !== false
    || contract.ingressAllowed !== false
    || contract.activationAllowed !== false) {
    fail("Unprovisioned DEV target must remain fully blocked");
  }
  if (contract.productionBindingState !== "UNBOUND_AFTER_ROUTER_AMENDMENT") {
    fail("Production binding must remain unbound");
  }
  const evidence = contract.evidence;
  exactKeys(evidence, [
    "capturedAt", "sourceHost", "sourceHostname", "sharedFlowSha256",
    "sharedFlowTargetPresent", "sharedFlowNodeCount", "sharedFlowHttpRouteCount",
    "sharedFlowTabCount", "sharedFlowBrokenWires", "sharedFlowBrokenLinks",
  ], "DEV provisioning evidence");
  const capturedAtMs = Date.parse(String(evidence.capturedAt || ""));
  const capturedAtCanonical = Number.isFinite(capturedAtMs)
    ? new Date(capturedAtMs).toISOString().replace(".000Z", "Z")
    : null;
  if (evidence.sourceHost !== "lk-reserve-89"
    || evidence.sourceHostname !== "89-108-64-209.cloudvps.regruhosting.ru"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(evidence.capturedAt || "")
    || capturedAtCanonical !== evidence.capturedAt
    || !/^[a-f0-9]{64}$/.test(evidence.sharedFlowSha256 || "")
    || evidence.sharedFlowTargetPresent !== false
    || ![evidence.sharedFlowNodeCount, evidence.sharedFlowHttpRouteCount,
      evidence.sharedFlowTabCount, evidence.sharedFlowBrokenWires,
      evidence.sharedFlowBrokenLinks].every((value) => Number.isInteger(value) && value >= 0)
    || evidence.sharedFlowBrokenWires !== 0
    || evidence.sharedFlowBrokenLinks !== 0) {
    fail("Shared-flow absence evidence is incomplete");
  }
  const forbidden = contract.forbiddenExistingResources;
  const target = contract.plannedTarget;
  exactKeys(forbidden, [
    "flowPath", "nodeRedListener", "nodeRedProcessUser", "productionApiProxy",
    "subscriptionShadowListener", "subscriptionShadowMongoListener",
  ], "Forbidden existing resources");
  exactKeys(target, [
    "sourceHost", "sourceHostname", "serviceName", "unixUser", "unixGroup",
    "userDir", "flowPath", "settingsPath", "listener", "ingress",
  ], "Planned DEV target");
  exactKeys(target.listener, ["host", "port", "protocol", "shared"], "Planned DEV listener");
  exactKeys(target.ingress, [
    "state", "origin", "configPath", "sharedListenerAllowed",
  ], "Planned DEV ingress");
  const listener = `${target.listener?.host}:${target.listener?.port}`;
  if (target.sourceHost !== "lk-reserve-89"
    || target.sourceHostname !== "89-108-64-209.cloudvps.regruhosting.ru"
    || target.serviceName !== "lk1-subscription-dev-nodered.service"
    || target.unixUser !== "lk1-subscription-dev"
    || target.unixGroup !== "lk1-subscription-dev"
    || target.userDir !== "/srv/lk1-subscription-dev/node-red"
    || target.flowPath !== `${target.userDir}/flows.json`
    || target.settingsPath !== `${target.userDir}/settings.js`
    || target.listener?.host !== "127.0.0.1"
    || target.listener?.port !== 1882
    || target.listener?.protocol !== "http"
    || target.listener?.shared !== false) {
    fail("Planned Node-RED target is not the exact dedicated loopback identity");
  }
  if (target.flowPath === forbidden.flowPath
    || listener === forbidden.nodeRedListener
    || target.unixUser === forbidden.nodeRedProcessUser) {
    fail("Planned Node-RED target reuses a forbidden shared resource");
  }
  if (target.ingress?.state !== "UNBOUND"
    || target.ingress.origin !== null
    || target.ingress.configPath !== null
    || target.ingress.sharedListenerAllowed !== false) {
    fail("DEV ingress must remain unbound before a separate target review");
  }
  const fixtures = contract.fixtureDependencies;
  exactKeys(fixtures, ["mongo", "cup", "provider", "identity"], "DEV fixture dependencies");
  exactKeys(fixtures.mongo, [
    "serviceName", "host", "port", "database", "dbPath", "shared",
  ], "DEV fixture Mongo");
  exactKeys(fixtures.cup, [
    "serviceName", "listener", "apiBase", "completeManagedContractRequired", "shared",
  ], "DEV fixture CUP");
  exactKeys(fixtures.provider, [
    "serviceName", "listener", "writesSyntheticOnly", "shared",
  ], "DEV fixture provider");
  exactKeys(fixtures.identity, [
    "serviceName", "listener", "identitiesSyntheticOnly", "shared",
  ], "DEV fixture identity");
  if (fixtures.mongo?.serviceName !== "lk1-subscription-dev-mongo.service"
    || fixtures.mongo?.host !== "127.0.0.1"
    || fixtures.mongo?.port !== 27030
    || fixtures.mongo?.database !== "lk1_subscription_dev_fixture"
    || fixtures.mongo?.dbPath !== "/srv/lk1-subscription-dev/mongo"
    || fixtures.mongo?.shared !== false
    || fixtures.cup?.serviceName !== "lk1-subscription-dev-cup.service"
    || fixtures.cup?.listener !== "127.0.0.1:3037"
    || fixtures.cup?.apiBase !== null
    || fixtures.cup?.completeManagedContractRequired !== true
    || fixtures.cup?.shared !== false
    || fixtures.provider?.serviceName !== "lk1-subscription-dev-provider-fixture.service"
    || fixtures.provider?.listener !== "127.0.0.1:3038"
    || fixtures.provider?.writesSyntheticOnly !== true
    || fixtures.provider?.shared !== false
    || fixtures.identity?.serviceName !== "lk1-subscription-dev-identity-fixture.service"
    || fixtures.identity?.listener !== "127.0.0.1:3039"
    || fixtures.identity?.identitiesSyntheticOnly !== true
    || fixtures.identity?.shared !== false) {
    fail("DEV fixture dependency identities are not isolated");
  }
  exactKeys(contract.networkPolicy, [
    "mode", "allowedHosts", "nonLoopbackEgressAllowed", "productionDnsAllowed",
  ], "DEV network policy");
  const fixtureListeners = [
    `${fixtures.mongo.host}:${fixtures.mongo.port}`,
    fixtures.cup.listener,
    fixtures.provider.listener,
    fixtures.identity.listener,
  ];
  if (fixtureListeners.includes(forbidden.subscriptionShadowListener)
    || fixtureListeners.includes(forbidden.subscriptionShadowMongoListener)
    || new Set([listener, ...fixtureListeners]).size !== 5) {
    fail("DEV fixture dependency reuses an existing or duplicate listener");
  }
  if (contract.networkPolicy?.mode !== "LOOPBACK_ONLY"
    || JSON.stringify(contract.networkPolicy.allowedHosts) !== JSON.stringify(["127.0.0.1", "::1"])
    || contract.networkPolicy.nonLoopbackEgressAllowed !== false
    || contract.networkPolicy.productionDnsAllowed !== false) {
    fail("DEV network policy must deny every non-loopback destination");
  }
  exactKeys(contract.runtimeFlags, [
    "expectedEnvironment", "managedProductIds", "canaryClientSubscriptionIds", "defaultOff",
  ], "DEV runtime flags");
  if (contract.runtimeFlags?.expectedEnvironment !== "DEV"
    || contract.runtimeFlags.defaultOff !== true
    || !Array.isArray(contract.runtimeFlags.managedProductIds)
    || !Array.isArray(contract.runtimeFlags.canaryClientSubscriptionIds)
    || contract.runtimeFlags.managedProductIds?.length !== 0
    || contract.runtimeFlags.canaryClientSubscriptionIds?.length !== 0) {
    fail("Unprovisioned DEV runtime flags must remain default-off");
  }
  exactKeys(contract.releaseIdentity, [
    "sourceSha256", "candidateSha256", "manifestSha256", "hostReadbackSha256",
  ], "DEV release identity");
  if (Object.values(contract.releaseIdentity || {}).some((value) => value !== null)) {
    fail("Unprovisioned DEV release identity must remain unbound");
  }
  exactKeys(contract.ingressAuthorization, [
    "approved", "origin", "certificateSpkiSha256", "listener", "configPath",
  ], "DEV ingress authorization");
  if (contract.ingressAuthorization.approved !== false
    || Object.entries(contract.ingressAuthorization)
      .some(([key, value]) => key !== "approved" && value !== null)) {
    fail("DEV ingress mutation must remain separately unauthorized and unbound");
  }
  exactKeys(contract.rollback, [
    "requiresSeparateAuthorization", "serviceStopOrder", "removeIngressBeforeListener",
    "preserveEvidenceAndLogs", "deleteData",
  ], "DEV rollback contract");
  const expectedStopOrder = [
    "lk1-subscription-dev-nodered.service",
    "lk1-subscription-dev-cup.service",
    "lk1-subscription-dev-provider-fixture.service",
    "lk1-subscription-dev-identity-fixture.service",
    "lk1-subscription-dev-mongo.service",
  ];
  if (contract.rollback?.requiresSeparateAuthorization !== true
    || JSON.stringify(contract.rollback.serviceStopOrder) !== JSON.stringify(expectedStopOrder)
    || contract.rollback.removeIngressBeforeListener !== true
    || contract.rollback.preserveEvidenceAndLogs !== true
    || contract.rollback.deleteData !== false) {
    fail("DEV rollback contract is not fail-safe");
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateDevProvisioningContract(checkedProvisioningContract);
  process.stdout.write("LK1_DEV_PROVISIONING_CONTRACT=BLOCKED_VALID\n");
}
