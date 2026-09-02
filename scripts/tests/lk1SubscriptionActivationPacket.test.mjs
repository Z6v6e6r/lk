import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LK1_ENFORCEMENT_CONTRACT } from "../prepare_lk1_subscription_enforcement_candidate.mjs";
import { LK1_SUBSCRIPTION_ENFORCEMENT_ACTIVATION_MANIFEST as manifest } from "../lk1_subscription_enforcement_activation_manifest.mjs";
import {
  assertExternalNewDirectory,
  buildActivationPlan,
  buildReviewedActivationContract,
  validateActivationManifest,
} from "../prepare_lk1_subscription_enforcement_activation_packet.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const previouslyBoundEnforcementContract = {
  ...LK1_ENFORCEMENT_CONTRACT,
  candidateBindingState: "BOUND",
  candidateSha256: manifest.candidateSha256,
};

test("LK1 activation manifest is invalidated after the router amendment", () => {
  assert.equal(manifest.sourceSha256, LK1_ENFORCEMENT_CONTRACT.sourceSha256);
  assert.equal(manifest.candidateSha256, LK1_ENFORCEMENT_CONTRACT.previousCandidateSha256);
  assert.equal(LK1_ENFORCEMENT_CONTRACT.candidateSha256, null);
  assert.throws(
    () => validateActivationManifest(),
    /contract is unbound after router amendment/,
  );
  for (const candidateBindingState of [undefined, "TYPO"]) {
    assert.throws(
      () => validateActivationManifest(manifest, {
        ...previouslyBoundEnforcementContract,
        candidateBindingState,
      }),
      /contract is unbound after router amendment/,
    );
  }
  const { changes, additions } = validateActivationManifest(
    manifest,
    previouslyBoundEnforcementContract,
  );
  assert.equal(changes.length, 54);
  assert.equal(additions.length, 50);
  assert.deepEqual(
    changes.find(({ id }) => id === "lk_subscription_booking_router_20260804")?.fields,
    ["func"],
  );
  assert.ok(additions.includes("lk_legacy_command_store_config_20260826"));
});

test("activation manifest rejects identity, count and overlap drift", () => {
  for (const drift of [
    { sourceSha256: "drift" },
    { changedNodeCount: 53 },
    { allowedAdditionIds: [...manifest.allowedAdditionIds, manifest.allowedChanges[0].id] },
  ]) {
    assert.throws(
      () => validateActivationManifest(
        { ...manifest, ...drift },
        previouslyBoundEnforcementContract,
      ),
      /identity or change budget mismatch/,
    );
  }
});

test("exact activation contract rejects unreviewed node and route changes", () => {
  const live = [
    { id: "route", type: "http in", method: "post", url: "/lk/subscription-bookings", wires: [["router"]] },
    { id: "router", type: "function", func: "return msg;", wires: [[]] },
  ];
  const candidate = [
    { ...live[0], wires: [["new-node"]] },
    { ...live[1], func: "msg.allowed = true; return msg;" },
    { id: "new-node", type: "function", func: "return msg;", wires: [["router"]] },
  ];
  const liveBytes = Buffer.from(`${JSON.stringify(live, null, 2)}\n`);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const fixture = {
    ...manifest,
    sourceSha256: sha256(liveBytes),
    candidateSha256: sha256(candidateBytes),
    sourceNodeCount: 2,
    candidateNodeCount: 3,
    httpInputCount: 1,
    changedNodeCount: 2,
    addedNodeCount: 1,
    allowedChanges: [
      { id: "route", fields: ["wires"] },
      { id: "router", fields: ["func"] },
    ],
    allowedAdditionIds: ["new-node"],
  };
  const fixtureEnforcement = {
    ...LK1_ENFORCEMENT_CONTRACT,
    candidateBindingState: "BOUND",
    sourceSha256: fixture.sourceSha256,
    candidateSha256: fixture.candidateSha256,
    nodeCount: 2,
    candidateNodeCount: 3,
    httpRouteCount: 1,
    changedExistingNodeCount: 2,
    addedNodeCount: 1,
  };
  assert.doesNotThrow(() => validateActivationManifest(fixture, fixtureEnforcement));
  const contract = buildReviewedActivationContract({
    liveBytes,
    candidateBytes,
    manifest: fixture,
    enforcementContract: fixtureEnforcement,
  });
  assert.equal(contract.allowedChanges.length, 2);
  assert.equal(contract.allowedAdditions.length, 1);
  const routeConfigDrift = structuredClone(candidate);
  routeConfigDrift[0].url = "/lk/changed";
  const routeConfigBytes = Buffer.from(`${JSON.stringify(routeConfigDrift, null, 2)}\n`);
  const routeConfigManifest = { ...fixture, candidateSha256: sha256(routeConfigBytes) };
  assert.throws(
    () => buildReviewedActivationContract({
      liveBytes,
      candidateBytes: routeConfigBytes,
      manifest: routeConfigManifest,
      enforcementContract: { ...fixtureEnforcement, candidateSha256: routeConfigManifest.candidateSha256 },
    }),
    /changed-node contract mismatch|HTTP route identity or configuration/,
  );
});

test("packet builder is offline-only and stops while the candidate contract is unbound", async () => {
  const source = await import("../prepare_lk1_subscription_enforcement_activation_packet.mjs?source-check");
  assert.equal(typeof source.prepareActivationPacket, "function");
  assert.equal(manifest.deploymentId, "lk1-subscription-enforcement");
  assert.doesNotMatch(source.prepareActivationPacket.toString(), /ssh|scp|apply --candidate|pm2|curl/);
  assert.throws(
    () => buildActivationPlan({
      repository: { commit: "a".repeat(40), branch: "codex/lk1-subscription-r4" },
      livePulledAt: "2026-08-27T14:02:00.000Z",
    }),
    /contract is unbound after router amendment/,
  );
});

test("packet output rejects existing paths and symlinked parent chains", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lk1-activation-output-")));
  try {
    const realParent = path.join(root, "real-parent");
    const linkedParent = path.join(root, "linked-parent");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, linkedParent);
    assert.equal(
      assertExternalNewDirectory(path.join(realParent, "packet")),
      path.join(realParent, "packet"),
    );
    assert.throws(
      () => assertExternalNewDirectory(path.join(linkedParent, "packet")),
      /real canonical directory/,
    );
    fs.mkdirSync(path.join(realParent, "existing"));
    assert.throws(
      () => assertExternalNewDirectory(path.join(realParent, "existing")),
      /new path/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
