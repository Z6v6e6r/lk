import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LIVE_SPLIT_CREATE_CONTRACT,
  applySplitCreateContract,
} from "../patch_live_split_create_contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  const liveSource = "msg.payload = { legacy: true }; return msg;";
  const candidateSource = "msg.payload = { documented: true }; return msg;";
  const contract = {
    id: "target-node",
    name: "Route Viva split payment",
    type: "function",
    tabId: "games-tab",
    outputs: 1,
    wires: [["next-node"]],
    liveFuncSha256: sha256(liveSource),
    candidateFuncSha256: sha256(candidateSource),
  };
  const flow = [
    {
      id: "games-tab",
      type: "tab",
      label: "Games",
    },
    {
      id: "target-node",
      z: "games-tab",
      type: "function",
      name: "Route Viva split payment",
      func: liveSource,
      outputs: 1,
      wires: [["next-node"]],
    },
    {
      id: "next-node",
      z: "games-tab",
      type: "http in",
      name: "Split create",
      method: "post",
      url: "/lk/games/split/create",
      wires: [[]],
    },
  ];
  return { flow, liveSource, candidateSource, contract };
}

test("tracked split sources are pinned to the reviewed candidate hashes", () => {
  for (const target of LIVE_SPLIT_CREATE_CONTRACT.targets) {
    const fileByKey = {
      create: "fn_split_create_prepare.js",
      join: "fn_split_join_prepare.js",
      router: "fn_split_router.js",
    };
    const source = fs.readFileSync(
      path.join(ROOT, "scripts/nodered_games_nodes", fileByKey[target.sourceKey]),
      "utf8",
    );
    assert.equal(sha256(source), target.candidateFuncSha256, target.sourceKey);
  }
});

test("candidate builder changes only the exact target function body", () => {
  const { flow, candidateSource, contract } = fixture();
  const before = structuredClone(flow);
  const result = applySplitCreateContract(flow, candidateSource, contract);

  assert.deepEqual(flow, before);
  assert.deepEqual(result.changedNodes, [{ id: "target-node", changedFields: ["func"] }]);
  assert.equal(result.candidate[1].func, candidateSource);
  assert.deepEqual(result.candidate[1].wires, before[1].wires);
  assert.deepEqual(result.candidate[2], before[2]);
});

test("candidate builder rejects a drifted live function", () => {
  const { flow, candidateSource, contract } = fixture();
  flow[1].func = "return null;";
  assert.throws(
    () => applySplitCreateContract(flow, candidateSource, contract),
    /function preimage mismatch/,
  );
});

test("candidate builder rejects topology drift", () => {
  const { flow, candidateSource, contract } = fixture();
  flow[1].wires = [["unexpected-node"]];
  assert.throws(
    () => applySplitCreateContract(flow, candidateSource, contract),
    /target node contract mismatch/,
  );
});

test("candidate builder rejects an unreviewed tracked postimage", () => {
  const { flow, contract } = fixture();
  assert.throws(
    () => applySplitCreateContract(flow, "return msg;", contract),
    /candidate source mismatch/,
  );
});
