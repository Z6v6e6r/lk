import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertStatusPriceLiveBaseline,
  buildFocusedStatusPriceCandidate,
  STATUS_PRICE_DEPLOYMENT_ID,
  STATUS_PRICE_LIVE_CONTRACT,
  STATUS_PRICE_TARGETS,
} from "../patch_live_subscription_status_price.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FN_DIR = path.join(ROOT, "scripts", "nodered_games_nodes");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
// Recorded for the exact preimage the generation was reviewed against.
const EXPECTED_CANDIDATE_SHA256 = "2ace2b60d0e246e84d5b9a542f6022ea1f7788c945dd855339e0ff0e47c09438";

test("status price generation pins one reviewed live function node", () => {
  assert.deepEqual(STATUS_PRICE_LIVE_CONTRACT, {
    sourceSha256: "87321a2f02cf2c00301346575445abd8d7ca1d24bf4b5e56ae2adeb8cdb258b0",
    nodeCount: 4799,
    httpInputCount: 219,
  });
  assert.equal(STATUS_PRICE_DEPLOYMENT_ID, "subscription-status-price-20260911");
  assert.equal(STATUS_PRICE_TARGETS.length, 1);
  for (const target of STATUS_PRICE_TARGETS) {
    assert.match(target.liveSha256, /^[a-f0-9]{64}$/);
    const source = fs.readFileSync(path.join(FN_DIR, target.fileName), "utf8");
    assert.equal(sha256(source), target.candidateSha256, target.fileName);
    assert.doesNotThrow(() => new Function("msg", "flow", "global", "node", "env", source));
  }
});

test("status price builder changes only the selected function body and declares one exact graph change", () => {
  const reviewed = STATUS_PRICE_TARGETS[0];
  const oldSource = "return msg;";
  const source = [{
    id: "synthetic-status-price",
    type: "function",
    z: "f9575c8726e29196",
    name: "Synthetic status price target",
    outputs: 1,
    wires: [[]],
    func: oldSource,
    x: 10,
    y: 20,
  }];
  const target = { ...reviewed, id: "synthetic-status-price", name: "Synthetic status price target", outputs: 1, liveSha256: sha256(oldSource) };
  const result = buildFocusedStatusPriceCandidate(source, [target]);
  assert.equal(source[0].func, oldSource);
  assert.deepEqual(result.changes, [{
    id: "synthetic-status-price",
    name: "Synthetic status price target",
    fields: ["func"],
  }]);
  assert.deepEqual(result.contract.allowedChanges.map((change) => change.id), ["synthetic-status-price"]);
  assert.deepEqual(result.contract.allowedAdditions, []);
  assert.equal(result.contract.candidateSha256, sha256(result.candidateBytes));
  assert.equal(result.flow[0].x, 10);
  assert.equal(result.flow[0].y, 20);
  assert.equal(result.flow[0].func, fs.readFileSync(path.join(FN_DIR, reviewed.fileName), "utf8"));
});

test("status price builder fails closed on preimage, candidate and change budget drift", () => {
  const reviewed = STATUS_PRICE_TARGETS[0];
  const node = (overrides = {}) => ({
    id: reviewed.id,
    type: "function",
    z: "f9575c8726e29196",
    name: reviewed.name,
    outputs: reviewed.outputs,
    wires: Array.from({ length: reviewed.outputs }, () => []),
    func: "drifted live function",
    ...overrides,
  });
  assert.throws(() => buildFocusedStatusPriceCandidate([node()], [reviewed]), /Live function preimage changed/);
  assert.throws(
    () => buildFocusedStatusPriceCandidate([node({ func: "x" })], [{ ...reviewed, liveSha256: sha256("x"), candidateSha256: "0".repeat(64) }]),
    /Candidate source changed/,
  );
  // A preimage that already carries the reviewed text cannot produce a change:
  // the generation is either already applied or its target is mis-declared.
  const reviewedSource = fs.readFileSync(path.join(FN_DIR, reviewed.fileName), "utf8");
  assert.throws(
    () => buildFocusedStatusPriceCandidate([node({ func: reviewedSource })], [{ ...reviewed, liveSha256: sha256(reviewedSource) }]),
    /Focused change budget mismatch/,
  );
});

const fixture = process.env.SUBSCRIPTION_STATUS_PRICE_LIVE_FIXTURE;
test("status price generation rejects any live baseline other than the reviewed preimage", () => {
  const source = [
    { id: "f9575c8726e29196", type: "tab", label: "LK Tournaments" },
    ...Array.from({ length: STATUS_PRICE_LIVE_CONTRACT.httpInputCount },
      (_, index) => ({ id: `synthetic-http-${index}`, type: "http in", method: "get", url: `/synthetic/${index}` })),
  ];
  const baseline = {
    sourceSha256: STATUS_PRICE_LIVE_CONTRACT.sourceSha256,
    nodeCount: STATUS_PRICE_LIVE_CONTRACT.nodeCount,
    source,
  };
  assert.equal(assertStatusPriceLiveBaseline(baseline), true);
  assert.throws(() => assertStatusPriceLiveBaseline({ ...baseline, sourceSha256: "0".repeat(64) }), /baseline changed/);
  assert.throws(() => assertStatusPriceLiveBaseline({ ...baseline, nodeCount: baseline.nodeCount - 1 }), /baseline changed/);
  assert.throws(
    () => assertStatusPriceLiveBaseline({ ...baseline, source: [...source, { id: "extra-http", type: "http in" }] }),
    /HTTP input count changed/,
  );
  assert.throws(
    () => assertStatusPriceLiveBaseline({
      ...baseline,
      source: source.map((node) => (node.id === "f9575c8726e29196" ? { ...node, disabled: true } : node)),
    }),
    /tab contract mismatch/,
  );
});
test("fresh private preimage composes exactly, keeps topology and reverses structurally", { skip: !fixture }, () => {
  const liveBytes = fs.readFileSync(fixture);
  const built = buildFocusedStatusPriceCandidate(liveBytes);
  const before = JSON.parse(liveBytes.toString("utf8"));
  assert.equal(before.length, built.flow.length);
  const changed = new Set(built.changes.map((change) => change.id));
  for (let index = 0; index < before.length; index += 1) {
    if (!changed.has(before[index].id)) assert.deepEqual(built.flow[index], before[index]);
  }
  assert.equal(new Set(built.flow.map((node) => node.id)).size, built.flow.length);
  assert.equal(built.flow.filter((node) => node.type === "http in").length, STATUS_PRICE_LIVE_CONTRACT.httpInputCount);
  assert.equal(sha256(built.candidateBytes), EXPECTED_CANDIDATE_SHA256);
  const reversed = structuredClone(built.flow);
  for (const change of built.changes) {
    const index = reversed.findIndex((node) => node.id === change.id);
    reversed[index].func = before[index].func;
  }
  assert.deepEqual(reversed, before);
  assert.throws(
    () => buildFocusedStatusPriceCandidate(
      Buffer.from(`${JSON.stringify(before.filter((entry) => entry.id !== STATUS_PRICE_TARGETS[0].id), null, 2)}\n`),
    ),
    /Target node contract mismatch/,
  );
});
