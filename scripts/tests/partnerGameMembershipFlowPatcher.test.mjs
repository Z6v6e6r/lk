import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PARTNER_API_FLOW_NODE_IDS,
  buildCandidateFile,
  buildPartnerGameMembershipApiCandidate,
  buildPartnerGameMembershipApiSidecarCandidate,
  parseArgs,
} from "../patch_partner_game_membership_api_flow.mjs";

const fixture = () => [
  { id: "lk-games-tab", type: "tab", label: "LK Games" },
  { id: "existing-route", type: "http in", z: "lk-games-tab", url: "/lk/games", method: "get", wires: [[]] },
];

test("flow patcher adds only the three separate M2M routes and one fail-closed handler", () => {
  const source = fixture();
  const result = buildPartnerGameMembershipApiCandidate(source);
  assert.equal(result.flow.length, source.length + 7);
  const routes = result.flow.filter((node) => node.type === "http in" && node.id !== "existing-route");
  assert.deepEqual(routes.map((node) => [node.method, node.url]), [
    ["post", "/lk/integrations/v1/open-games/:gameId/members"],
    ["delete", "/lk/integrations/v1/open-games/:gameId/members/:membershipId"],
    ["get", "/lk/integrations/v1/operations/:operationId"],
  ]);
  assert.ok(routes.every((node) => node.wires[0][0] === PARTNER_API_FLOW_NODE_IDS.handler));
  const store = result.flow.find((node) => node.id === PARTNER_API_FLOW_NODE_IDS.store);
  assert.equal(store.enabledEnv, "LK_PARTNER_GAME_API_ENABLED");
  assert.equal(store.audienceEnv, "LK_PARTNER_GAME_API_AUDIENCE");
  assert.equal(store.vivaMutationsEnabledEnv, "LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED");
  assert.equal(store.vivaContractRevisionEnv, "LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION");
  assert.equal(store.vivaIdempotencyConfirmedEnv, "LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED");
  assert.equal(store.vivaOnPlaceConfirmedEnv, "LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED");
  assert.equal(source.length, 2, "source preimage must remain unchanged");
});

test("sidecar builder creates the exact isolated one-tab preimage and eight-node candidate", () => {
  const result = buildPartnerGameMembershipApiSidecarCandidate();
  assert.deepEqual(result.sourceFlow, [{ id: "partner-rehearsal-tab", type: "tab", label: "LK Games" }]);
  assert.equal(result.flow.length, 8);
  assert.deepEqual(result.flow[0], result.sourceFlow[0]);
  assert.deepEqual(result.addedNodeIds, Object.values(PARTNER_API_FLOW_NODE_IDS));
  assert.ok(result.flow.slice(1).every((node) => node.z === undefined || node.z === "partner-rehearsal-tab"));
});

test("flow patcher rejects namespace collisions, missing tabs, and stale source hashes", () => {
  assert.throws(
    () => buildPartnerGameMembershipApiCandidate([{ id: "tab", type: "tab", label: "Other" }]),
    /exactly one source tab/,
  );
  assert.throws(
    () => buildPartnerGameMembershipApiCandidate([
      ...fixture(),
      { id: "collision", type: "http in", url: "/lk/integrations/v1/other", method: "post" },
    ]),
    /route namespace is already present/,
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "partner-api-flow-test-"));
  const input = path.join(temp, "source.json");
  const output = path.join(temp, "candidate.json");
  fs.writeFileSync(input, `${JSON.stringify(fixture())}\n`);
  assert.throws(
    () => buildCandidateFile({ input, output, sourceSha256: "0".repeat(64), sourceTabLabel: "LK Games" }),
    /SHA-256 mismatch/,
  );
});

test("candidate builder requires an exact live-source digest and never writes in place", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "partner-api-flow-test-"));
  const input = path.join(temp, "source.json");
  const output = path.join(temp, "candidate.json");
  const bytes = Buffer.from(`${JSON.stringify(fixture(), null, 2)}\n`);
  fs.writeFileSync(input, bytes);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = buildCandidateFile({ input, output, sourceSha256: digest, sourceTabLabel: "LK Games" });
  assert.equal(manifest.artifact, "partner-game-membership-api-v0.2-candidate");
  assert.equal(manifest.topology, "DEDICATED_LOOPBACK_SIDECAR");
  assert.equal(manifest.sharedFlowMutationAllowed, false);
  assert.equal(manifest.deploymentPerformed, false);
  assert.equal(manifest.activationPerformed, false);
  assert.equal(manifest.liveReadback.sha256, digest);
  const candidate = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(candidate.length, 8);
  assert.equal(candidate.some((node) => node.id === "existing-route"), false);
  assert.equal(candidate[0].id, "partner-rehearsal-tab");
  assert.equal(fs.existsSync(`${output}.manifest.json`), true);
  assert.throws(
    () => parseArgs(["--input", input, "--output", input, "--source-sha256", digest]),
    /In-place flow mutation is forbidden/,
  );
});
