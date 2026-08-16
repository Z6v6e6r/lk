import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const patcher = "scripts/patch_live_tournament_history_resilience.mjs";
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const makeFlow = () => ([
  {
    id: "ccd7d6b82f8b90c1", type: "http in", z: "tab-1", name: "Americano history",
    method: "get", url: "/lk/tournaments/americano/history", wires: [["11b8491cc624fb42"]],
  },
  {
    id: "11b8491cc624fb42", type: "change", z: "tab-1", name: "History by tournamentId",
    wires: [["ddc581fde0073e34"]],
  },
  {
    id: "ddc581fde0073e34", type: "mongodb4", z: "tab-1", name: "Find tournament history",
    clientNode: "mongo-1", collection: "tournaments", operation: "find", output: "toArray",
    maxTimeMS: "5000", wires: [["tournament_community_history_query_20260811"]],
  },
  {
    id: "tournament_community_history_query_20260811", type: "function", z: "tab-1",
    name: "Find tournament publications", func: "return msg;",
    wires: [["tournament_community_history_feed_20260811"]],
  },
  {
    id: "tournament_community_history_feed_20260811", type: "mongodb4", z: "tab-1",
    name: "Find active tournament publications", clientNode: "mongo-1",
    collection: "lk_community_feed", operation: "find", output: "toArray",
    maxTimeMS: "5000", wires: [["tournament_community_history_attach_20260811"]],
  },
  {
    id: "tournament_community_history_attach_20260811", type: "function", z: "tab-1",
    name: "Attach published communities", func: "return msg;", wires: [["a57565a6ddbb532f"]],
  },
  { id: "a57565a6ddbb532f", type: "http response", z: "tab-1", name: "", wires: [] },
  { id: "route-2", type: "http in", z: "tab-1", name: "Other", method: "get", url: "/other", wires: [[]] },
]);

const run = (flow: unknown[], expectedBody?: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-resilience-patch-"));
  const input = path.join(tempDir, "flow.json");
  const output = path.join(tempDir, "candidate.json");
  const report = path.join(tempDir, "report.json");
  const body = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(input, body);
  const result = spawnSync(process.execPath, [
    patcher,
    "--input", input,
    "--output", output,
    "--report", report,
    "--expected-flow-sha256", sha256(expectedBody ?? body),
  ], { encoding: "utf8" });
  return { tempDir, input, output, report, body, result };
};

test("history resilience adds bounded reads and a scoped 503 catch path", (t) => {
  const result = run(makeFlow());
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(fs.readFileSync(result.input, "utf8"), result.body);
  const candidate = JSON.parse(fs.readFileSync(result.output, "utf8"));
  const report = JSON.parse(fs.readFileSync(result.report, "utf8"));
  assert.equal(candidate.find((node: any) => node.id === "ddc581fde0073e34").limit, "1");
  assert.equal(
    candidate.find((node: any) => node.id === "tournament_community_history_feed_20260811").limit,
    "50",
  );
  const catchNode = candidate.find((node: any) => node.id === "tournament_history_storage_catch_20260816");
  assert.deepEqual(catchNode.scope, [
    "ddc581fde0073e34",
    "tournament_community_history_feed_20260811",
  ]);
  assert.equal(report.addedNodeIds.length, 3);
  assert.equal(report.invariants.httpInputRoutesUnchanged, true);
  assert.equal(fs.statSync(result.output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.report).mode & 0o777, 0o600);
});

test("history resilience rejects whole-flow drift before writing artifacts", (t) => {
  const baseline = makeFlow();
  const baselineBody = `${JSON.stringify(baseline, null, 2)}\n`;
  const drifted = makeFlow();
  (drifted.at(-1) as any).url = "/drifted";
  const result = run(drifted, baselineBody);
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  assert.notEqual(result.result.status, 0);
  assert.match(result.result.stderr, /Flow preimage mismatch/);
  assert.equal(fs.existsSync(result.output), false);
  assert.equal(fs.existsSync(result.report), false);
});

test("history storage error response is a safe retryable 503", () => {
  const fn = fs.readFileSync(
    "scripts/nodered_games_nodes/fn_tournament_history_storage_error.js",
    "utf8",
  );
  const msg = { error: { message: "Mongo secret detail" }, payload: { raw: "private" } };
  const output = new Function("msg", fn)(msg);
  assert.equal(output.statusCode, 503);
  assert.equal(output.headers["Retry-After"], "5");
  assert.equal(output.payload.code, "TOURNAMENT_HISTORY_STORAGE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(output), /Mongo secret detail|private/);
});
