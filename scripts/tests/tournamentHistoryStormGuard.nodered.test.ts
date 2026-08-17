import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const guardSource = fs.readFileSync(
  "scripts/nodered_games_nodes/fn_tournament_history_request_guard.js",
  "utf8",
);
const cacheStoreSource = fs.readFileSync(
  "scripts/nodered_games_nodes/fn_tournament_history_cache_store.js",
  "utf8",
);
const guardFn = new Function("msg", "flow", "Date", guardSource);
const cacheStoreFn = new Function("msg", "flow", "Date", cacheStoreSource);

function createFlowContext() {
  const values = new Map<string, unknown>();
  return {
    get(key: string) {
      return values.get(key);
    },
    set(key: string, value: unknown) {
      values.set(key, value);
    },
  };
}

function clock(now: number) {
  return { now: () => now };
}

function requestMsg(tournamentId = "tournament-1", sourceIp = "203.0.113.10") {
  return {
    req: {
      query: { tournamentId },
      headers: { "x-real-ip": sourceIp },
      socket: { remoteAddress: "127.0.0.1" },
    },
  };
}

test("history guard validates the id and returns safe rate-limit responses", () => {
  const flow = createFlowContext();
  const invalid = guardFn(requestMsg(""), flow, clock(0));
  assert.equal(invalid[0].statusCode, 400);
  assert.equal(invalid[0].payload.code, "TOURNAMENT_ID_REQUIRED");

  let limited: any = null;
  for (let index = 0; index < 25; index += 1) {
    limited = guardFn(requestMsg(), flow, clock(index * 1_000));
  }
  assert.equal(limited[0].statusCode, 429);
  assert.equal(limited[0].payload.code, "TOURNAMENT_HISTORY_RATE_LIMITED");
  assert.ok(Number(limited[0].headers["Retry-After"]) > 0);
  assert.doesNotMatch(JSON.stringify(limited[0].payload), /203\.0\.113\.10|tournament-1/);
});

test("history cache stores successful arrays and serves them before Mongo", () => {
  const flow = createFlowContext();
  const first = guardFn(requestMsg(), flow, clock(0));
  assert.equal(first[0], null);
  assert.equal(first[1]._tournamentHistoryCacheKey, "id:tournament-1");

  const stored = cacheStoreFn({
    ...first[1],
    payload: [{ tournamentId: "tournament-1", summary: { status: "completed" } }],
  }, flow, clock(100));
  assert.equal(stored._tournamentHistoryCacheKey, undefined);

  const hit = guardFn(requestMsg(), flow, clock(1_000));
  assert.equal(hit[1], null);
  assert.equal(hit[0].statusCode, 200);
  assert.deepEqual(hit[0].payload, [{ tournamentId: "tournament-1", summary: { status: "completed" } }]);

  const expired = guardFn(requestMsg(), flow, clock(10_101));
  assert.equal(expired[0], null);
  assert.equal(expired[1]._tournamentHistoryCacheKey, "id:tournament-1");
});

test("two 3-second loops are bounded to four storage reads and then rate-limited", () => {
  const flow = createFlowContext();
  let storageReads = 0;
  let rateLimited = 0;

  for (let index = 0; index < 40; index += 1) {
    const now = index * 1_500;
    const guarded = guardFn(requestMsg(), flow, clock(now));
    if (guarded[0]?.statusCode === 429) {
      rateLimited += 1;
      continue;
    }
    if (guarded[1]) {
      storageReads += 1;
      cacheStoreFn({ ...guarded[1], payload: [{ tournamentId: "tournament-1" }] }, flow, clock(now));
    }
  }

  assert.equal(storageReads, 4);
  assert.equal(rateLimited, 16);
});

const patcher = "scripts/patch_live_tournament_history_storm_guard.mjs";
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const makeFlow = () => ([
  {
    id: "ccd7d6b82f8b90c1", type: "http in", z: "tab-1", name: "Americano history",
    method: "get", url: "/lk/tournaments/americano/history", wires: [["11b8491cc624fb42", "0299bf5612ade8d5"]],
  },
  {
    id: "0299bf5612ade8d5", type: "debug", z: "tab-1", name: "Americano save payload",
    active: false, wires: [],
  },
  {
    id: "11b8491cc624fb42", type: "change", z: "tab-1", name: "History by tournamentId",
    wires: [["ddc581fde0073e34"]],
  },
  {
    id: "ddc581fde0073e34", type: "mongodb4", z: "tab-1", name: "Find tournament history",
    clientNode: "mongo-1", collection: "tournaments", operation: "find", output: "toArray",
    maxTimeMS: "5000", limit: "1", wires: [["tournament_community_history_query_20260811"]],
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
    maxTimeMS: "5000", limit: "50", wires: [["tournament_community_history_attach_20260811"]],
  },
  {
    id: "tournament_community_history_attach_20260811", type: "function", z: "tab-1",
    name: "Attach published communities", func: "return msg;", wires: [["a57565a6ddbb532f"]],
  },
  { id: "a57565a6ddbb532f", type: "http response", z: "tab-1", name: "", wires: [] },
  {
    id: "tournament_history_storage_catch_20260816", type: "catch", z: "tab-1",
    name: "Catch tournament history storage errors",
    scope: ["ddc581fde0073e34", "tournament_community_history_feed_20260811"],
    uncaught: false, wires: [["tournament_history_storage_error_20260816"]],
  },
  {
    id: "tournament_history_storage_error_20260816", type: "function", z: "tab-1",
    name: "Build tournament history storage error", func: "return msg;",
    wires: [["tournament_history_storage_response_20260816"]],
  },
  {
    id: "tournament_history_storage_response_20260816", type: "http response", z: "tab-1",
    name: "Tournament history storage error response", wires: [],
  },
  { id: "route-2", type: "http in", z: "tab-1", name: "Other", method: "get", url: "/other", wires: [[]] },
]);

function runPatcher(flow: unknown[], expectedBody?: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-storm-guard-"));
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
}

test("storm patch adds only guarded cache nodes and preserves bounded storage", (t) => {
  const run = runPatcher(makeFlow());
  t.after(() => fs.rmSync(run.tempDir, { recursive: true, force: true }));
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(fs.readFileSync(run.input, "utf8"), run.body);

  const candidate = JSON.parse(fs.readFileSync(run.output, "utf8"));
  const report = JSON.parse(fs.readFileSync(run.report, "utf8"));
  assert.deepEqual(candidate.find((node: any) => node.id === "ccd7d6b82f8b90c1").wires, [
    ["tournament_history_request_guard_20260817"],
  ]);
  assert.deepEqual(
    candidate.find((node: any) => node.id === "tournament_history_request_guard_20260817").wires,
    [["a57565a6ddbb532f"], ["11b8491cc624fb42", "0299bf5612ade8d5"]],
  );
  assert.deepEqual(
    candidate.find((node: any) => node.id === "tournament_community_history_attach_20260811").wires,
    [["tournament_history_cache_store_20260817"]],
  );
  assert.equal(candidate.find((node: any) => node.id === "ddc581fde0073e34").limit, "1");
  assert.equal(
    candidate.find((node: any) => node.id === "tournament_community_history_feed_20260811").limit,
    "50",
  );
  assert.deepEqual(report.changedExistingNodeIds, [
    "ccd7d6b82f8b90c1",
    "tournament_community_history_attach_20260811",
  ]);
  assert.equal(report.invariants.httpInputRoutesUnchanged, true);
  assert.equal(report.invariants.brokenWires, 0);
});

test("storm patch rejects whole-flow drift before writing artifacts", (t) => {
  const baseline = makeFlow();
  const baselineBody = `${JSON.stringify(baseline, null, 2)}\n`;
  const drifted = makeFlow();
  (drifted.at(-1) as any).url = "/drifted";
  const run = runPatcher(drifted, baselineBody);
  t.after(() => fs.rmSync(run.tempDir, { recursive: true, force: true }));
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /Flow preimage mismatch/);
  assert.equal(fs.existsSync(run.output), false);
  assert.equal(fs.existsSync(run.report), false);
});
