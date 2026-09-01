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
  assert.equal(result.flow.find((node) => node.id === PARTNER_API_FLOW_NODE_IDS.store).enabledEnv, "LK_PARTNER_GAME_API_ENABLED");
  assert.equal(source.length, 2, "source preimage must remain unchanged");
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
  assert.equal(manifest.deploymentPerformed, false);
  assert.equal(manifest.activationPerformed, false);
  assert.equal(manifest.source.sha256, digest);
  assert.equal(fs.existsSync(`${output}.manifest.json`), true);
  assert.throws(
    () => parseArgs(["--input", input, "--output", input, "--source-sha256", digest]),
    /In-place flow mutation is forbidden/,
  );
});
