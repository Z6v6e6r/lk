import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const PACKET_PATH =
  "architecture-workspace/evidence/subscriptions/PITER_HUB_ACTIVATION_PACKET_20260823.json";
const CHECK_SCRIPT = "scripts/check_piter_hub_activation_packet.mjs";

test("Piter/HUB activation packet is read-only and internally consistent", () => {
  const result = spawnSync(process.execPath, [CHECK_SCRIPT, "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, {
    status: "VALID",
    mutationAllowed: false,
    piterTargetVersion: 2,
    hubTargetVersion: 2,
    hubStationCount: 25,
    hubStationSetSha256: "cc774da8899ecb71f4c0514f84240719588c51ed5049c84d716dd4ae79acf0f1",
    publicationBlockerCount: 10,
    futureMutationGateCount: 10,
  });
});

test("activation packet exposes no executable production mutation", () => {
  const packet = JSON.parse(fs.readFileSync(PACKET_PATH, "utf8"));
  assert.equal(packet.mutationAllowed, false);
  assert.ok(packet.runtimeFlagPlan.every((step) => step.authorized === false));
  assert.ok(packet.futureMutationGates.every((step) => (
    step.authorized === false && step.command === null
  )));
  assert.equal(packet.dynamicPublicationInputs.expectedPolicyDigest, null);
  assert.equal(packet.dynamicPublicationInputs.expectedImpactPreviewRef, null);
  assert.equal(packet.dynamicPublicationInputs.approvalReason, null);
});

test("historical HUB v1 remains explicitly forbidden for publication", () => {
  const packet = JSON.parse(fs.readFileSync(PACKET_PATH, "utf8"));
  const hub = packet.candidates.find((candidate) => candidate.scope === "HUB");
  assert.ok(hub);
  assert.equal(hub.currentVersion, 1);
  assert.equal(hub.currentSelectorKind, "ALL_STATIONS");
  assert.equal(hub.targetVersion, 2);
  assert.equal(hub.targetSelectorKind, "STATION_LIST");
  assert.ok(packet.publicationBlockers.includes("OLD_HUB_V1_USES_ALL_STATIONS"));
});

test("checker rejects every mode except explicit --check", () => {
  for (const args of [[], ["--apply"], ["--render=HUB"]]) {
    const result = spawnSync(process.execPath, [CHECK_SCRIPT, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});
