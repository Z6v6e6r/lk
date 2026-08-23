#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_PATH = path.join(
  ROOT,
  "architecture-workspace/evidence/subscriptions/PITER_HUB_ACTIVATION_PACKET_20260823.json",
);

if (process.argv.length !== 3 || process.argv[2] !== "--check") {
  process.stderr.write("Usage: node scripts/check_piter_hub_activation_packet.mjs --check\n");
  process.exitCode = 2;
} else {
  const packet = JSON.parse(fs.readFileSync(PACKET_PATH, "utf8"));
  const byScope = new Map(packet.candidates.map((candidate) => [candidate.scope, candidate]));
  const piter = byScope.get("PITER");
  const hub = byScope.get("HUB");
  const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const sortedUnique = (values) => [...new Set(values)].sort();
  const stationSetSha256 = (values) => sha256(`${sortedUnique(values).join("\n")}\n`);
  const dictionaryRevision = (candidate) => {
    const dictionary = {
      provider: "VIVA",
      stationIds: sortedUnique(candidate.stationIds),
      directionId: "4588",
      typeId: "1613",
      canonicalExternalEventTypeId: packet.policyInvariants.canonicalExternalEventTypeId,
    };
    return `annual-v2-${sha256(JSON.stringify(dictionary))}`;
  };

  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.status, "PREPARED_NOT_APPLIED");
  assert.equal(packet.mutationAllowed, false);
  assert.deepEqual([...byScope.keys()].sort(), ["HUB", "PITER"]);
  assert.ok(piter);
  assert.ok(hub);

  assert.equal(packet.productionAudit.providerMappings, 0);
  assert.equal(packet.productionAudit.policyPublications, 0);
  assert.equal(packet.productionAudit.subscriptionInstances, 0);
  assert.equal(packet.productionAudit.usageLedgerEvents, 0);
  assert.deepEqual(packet.productionAudit.runtimeFlagsEnabled, []);

  assert.equal(packet.policyInvariants.activationMode, "FIRST_USE_OR_FIXED_DATE");
  assert.equal(packet.policyInvariants.activationWindowDays, 0);
  assert.equal(packet.policyInvariants.fixedActivationAt, "2026-09-30T21:00:00.000Z");
  assert.equal(packet.policyInvariants.fixedActivationTimeZone, "Europe/Moscow");
  assert.equal(packet.policyInvariants.validityDays, 365);
  assert.equal(packet.policyInvariants.dailyUsageLimit, 1);
  assert.deepEqual(packet.policyInvariants.createDurationsMinutes, [60]);
  assert.deepEqual(packet.policyInvariants.joinDurationsMinutes, [60, 90, 120]);
  assert.deepEqual(packet.policyInvariants.usageUnitsByDuration, { "60": 1, "90": 1, "120": 1 });
  assert.equal(packet.policyInvariants.groupTrainingBenefitConfigured, false);
  assert.equal(packet.policyInvariants.tournamentBenefitConfigured, false);
  assert.equal(packet.policyInvariants.create90Or120AddOnConfigured, false);

  for (const candidate of [piter, hub]) {
    assert.equal(candidate.currentVersion, 1);
    assert.equal(candidate.currentStatus, "DRAFT");
    assert.equal(candidate.targetVersion, 2);
    assert.equal(candidate.targetSelectorKind, "STATION_LIST");
    assert.equal(candidate.stationIds.length, sortedUnique(candidate.stationIds).length);
    assert.equal(candidate.dictionaryRevision, dictionaryRevision(candidate));
  }

  assert.equal(piter.stationIds.length, 1);
  assert.equal(piter.currentSelectorKind, "STATION_LIST");
  assert.equal(hub.stationIds.length, 25);
  assert.equal(hub.currentSelectorKind, "ALL_STATIONS");
  assert.equal(stationSetSha256(hub.stationIds), packet.stationEvidence.providerStationSetSha256);
  assert.equal(
    packet.stationEvidence.providerStationSetSha256,
    packet.stationEvidence.cupCandidateStationSetSha256,
  );
  assert.equal(packet.stationEvidence.matchesCupCandidate, true);
  assert.equal(packet.stationEvidence.direction4588Observed, true);
  assert.equal(packet.stationEvidence.type1613Observed, false);
  assert.equal(packet.stationEvidence.dictionaryEvidenceRef, null);

  assert.deepEqual(packet.dynamicPublicationInputs, {
    providerPreviewStudioId: null,
    dictionaryEvidenceRef: null,
    expectedPolicyDigest: null,
    expectedImpactPreviewRef: null,
    approvalReason: null,
  });
  for (const required of [
    "OLD_HUB_V1_USES_ALL_STATIONS",
    "CANONICAL_DICTIONARY_TYPE_EVIDENCE_REQUIRED",
    "REAL_CANONICAL_TARGET_PRODUCER_EVIDENCE_REQUIRED",
    "CUP_POLICY_V2_NOT_CREATED",
    "POST_PUBLICATION_POLICY_SUPERSESSION_NOT_IMPLEMENTED",
    "CUP_INSTANCE_IMPORT_COMMAND_NOT_IMPLEMENTED",
    "PITER_EXISTING_ACTIVE_INSTANCE_DECISION_REQUIRED",
    "RUNTIME_SECRETS_NOT_PROVISIONED",
    "CUP_RUNTIME_FLAGS_DISABLED",
  ]) {
    assert.ok(packet.publicationBlockers.includes(required), `Missing blocker ${required}`);
  }

  assert.deepEqual(
    packet.runtimeFlagPlan.map((step) => step.order),
    packet.runtimeFlagPlan.map((_, index) => index + 1),
  );
  assert.ok(packet.runtimeFlagPlan.every((step) => step.authorized === false));
  assert.deepEqual(
    packet.futureMutationGates.map((step) => step.order),
    packet.futureMutationGates.map((_, index) => index + 1),
  );
  assert.ok(packet.futureMutationGates.every((step) => (
    step.authorized === false && step.command === null
  )));

  process.stdout.write(`${JSON.stringify({
    status: "VALID",
    mutationAllowed: false,
    piterTargetVersion: piter.targetVersion,
    hubTargetVersion: hub.targetVersion,
    hubStationCount: hub.stationIds.length,
    hubStationSetSha256: stationSetSha256(hub.stationIds),
    publicationBlockerCount: packet.publicationBlockers.length,
    futureMutationGateCount: packet.futureMutationGates.length,
  }, null, 2)}\n`);
}
