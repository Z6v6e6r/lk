import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const functionPath =
  "scripts/nodered_games_nodes/fn_tournament_recalculate.js";
const patcherPath =
  "scripts/patch_live_tournament_finished_at_idempotency.mjs";
const candidateSha256 =
  "b46468ecffddd481bd4eed456c665b51226e156be34df93a4fa6a01a2747ddc6";

const sha256 = (value: string) => (
  crypto.createHash("sha256").update(value, "utf8").digest("hex")
);

function runTournamentRecalculation(msg: Record<string, unknown>) {
  const source = fs.readFileSync(functionPath, "utf8");
  return new Function("msg", source)(msg) as {
    statusCode?: number;
    mongoQuery?: Record<string, unknown>;
    mongoUpdate?: {
      $set?: {
        rounds?: unknown[];
      };
    };
    payload: {
      error?: string;
      params?: Record<string, unknown>;
      rounds?: Array<{
        id?: string;
        matches?: Array<{
          id?: string;
          pair1?: unknown[];
          pair2?: unknown[];
          score1?: number;
          score2?: number;
        }>;
      }>;
      summary?: Record<string, unknown>;
    };
  };
}

test("completed tournament keeps its first finishedAt on repeated result save", () => {
  const originalFinishedAt = "2026-07-25T10:09:10.449Z";
  const originalCompletedAt = "2026-07-25T10:09:11.001Z";
  const repeatedFinishedAt = "2026-07-25T10:15:26.675Z";
  const participants = Array.from({ length: 4 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: String(2 - index * 0.1),
  }));
  const result = runTournamentRecalculation({
    payload: {
      tournamentId: "completed-1",
      tournamentType: "americano",
      participants,
      courts: ["Корт №1"],
      params: {
        status: "completed",
        finished: true,
        manualFinish: true,
        finishedAt: originalFinishedAt,
        completedAt: originalCompletedAt,
      },
      summary: {
        status: "completed",
        finished: true,
        manualFinish: true,
        finishedAt: originalFinishedAt,
        completedAt: originalCompletedAt,
      },
      rounds: [{
        id: "round-1",
        index: 1,
        matches: [{
          id: "match-1",
          pair1: ["p1", "p2"],
          pair2: ["p3", "p4"],
          score1: 12,
          score2: 9,
        }],
      }],
    },
    req: {
      body: {
        results: [],
        params: {
          status: "completed",
          finished: true,
          manualFinish: true,
          finishedAt: repeatedFinishedAt,
          completedAt: repeatedFinishedAt,
        },
      },
    },
  });

  assert.equal(result.payload.params?.finishedAt, originalFinishedAt);
  assert.equal(result.payload.params?.completedAt, originalCompletedAt);
  assert.equal(result.payload.summary?.finishedAt, originalFinishedAt);
  assert.equal(result.payload.summary?.completedAt, originalCompletedAt);
});

test("classic mexicano rejects a score-only result without a persisted layout", () => {
  const participants = Array.from({ length: 4 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: String(2 - index * 0.1),
  }));
  const tournament = {
    tournamentId: "mexicano-score-only",
    tournamentType: "mexicano",
    participants,
    courts: ["Корт №1"],
    params: { mexicanoMode: "classic" },
    rounds: [],
  };

  const result = runTournamentRecalculation({
    payload: tournament,
    req: {
      body: {
        results: [{
          roundId: "round-1",
          matchId: "round-1-match-1",
          score1: 14,
          score2: 11,
        }],
      },
    },
  });

  assert.equal(result.statusCode, 422);
  assert.equal(result.payload.error, "ROUND_LAYOUT_REQUIRED");
  assert.deepEqual(tournament.rounds, []);
  assert.equal(result.mongoQuery, undefined);
  assert.equal(result.mongoUpdate, undefined);
});

test("classic mexicano accepts and persists a valid frontend round layout", () => {
  const participants = Array.from({ length: 4 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: String(2 - index * 0.1),
  }));

  const result = runTournamentRecalculation({
    payload: {
      tournamentId: "mexicano-valid-layout",
      tournamentType: "mexicano",
      participants,
      courts: ["Корт №1"],
      params: { mexicanoMode: "classic" },
      rounds: [],
    },
    req: {
      body: {
        results: [{
          roundId: "round-1",
          matchId: "round-1-match-1",
          pair1: ["p1", "p2"],
          pair2: ["p3", "p4"],
          court: "Корт №1",
          courtIndex: 0,
        }],
      },
    },
  });

  const persistedRound = result.payload.rounds?.[0];
  const persistedMatch = persistedRound?.matches?.[0];
  assert.equal(result.statusCode, undefined);
  assert.equal(persistedRound?.id, "round-1");
  assert.equal(persistedMatch?.id, "round-1-match-1");
  assert.deepEqual(persistedMatch?.pair1, ["p1", "p2"]);
  assert.deepEqual(persistedMatch?.pair2, ["p3", "p4"]);
  assert.deepEqual(result.mongoQuery, { tournamentId: "mexicano-valid-layout" });
  assert.deepEqual(result.mongoUpdate?.$set?.rounds, result.payload.rounds);
});

test("resumeRequested clears completion state before recalculation", () => {
  const completedAt = "2026-07-26T10:56:54.734Z";
  const participants = Array.from({ length: 4 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: String(2 - index * 0.1),
  }));

  const result = runTournamentRecalculation({
    payload: {
      tournamentId: "mexicano-resume",
      tournamentType: "mexicano",
      participants,
      courts: ["Корт №1"],
      params: {
        mexicanoMode: "classic",
        status: "completed",
        finished: true,
        manualFinish: true,
        finishedAt: completedAt,
        completedAt,
      },
      summary: {
        status: "completed",
        finished: true,
        manualFinish: true,
        finishedAt: completedAt,
        completedAt,
      },
      rounds: [{
        id: "round-1",
        index: 1,
        matches: [{
          id: "round-1-match-1",
          pair1: ["p1", "p2"],
          pair2: ["p3", "p4"],
          score1: 14,
          score2: 11,
        }],
      }],
    },
    req: {
      body: {
        results: [],
        params: { resumeRequested: true },
      },
    },
  });

  assert.equal(result.payload.params?.status, "in_progress");
  assert.equal(result.payload.params?.finished, false);
  assert.equal(result.payload.params?.manualFinish, false);
  assert.equal(result.payload.params?.finishedAt, null);
  assert.equal(result.payload.params?.completedAt, null);
  assert.equal("resumeRequested" in (result.payload.params || {}), false);
  assert.equal(result.payload.summary?.status, "in_progress");
  assert.equal(result.payload.summary?.finished, false);
  assert.equal("finishedAt" in (result.payload.summary || {}), false);
  assert.equal("completedAt" in (result.payload.summary || {}), false);
});

test("guarded candidate builder changes only the expected function node", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lk-nodered-rating-recovery-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, "report.json");
  const oldFunction = "msg.payload = { old: true };\\nreturn msg;";
  const flow = [
    { id: "tab-1", type: "tab", label: "LK Tournaments" },
    {
      id: "route-1",
      type: "http in",
      z: "tab-1",
      name: "Save results",
      method: "post",
      url: "/lk/tournaments/americano/results",
      wires: [["target-node"]],
    },
    {
      id: "target-node",
      type: "function",
      z: "tab-1",
      name: "Recalculate ratings & totals",
      func: oldFunction,
      wires: [["response-1"]],
    },
    {
      id: "response-1",
      type: "http response",
      z: "tab-1",
      wires: [],
    },
  ];
  const inputBody = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(inputPath, inputBody);
  const inputBefore = fs.readFileSync(inputPath, "utf8");

  const run = spawnSync(process.execPath, [
    patcherPath,
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--expected-node-id", "target-node",
    "--expected-node-type", "function",
    "--expected-node-name", "Recalculate ratings & totals",
    "--expected-sha256", sha256(oldFunction),
    "--expected-flow-sha256", sha256(inputBody),
  ], { encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(inputPath, "utf8"), inputBefore);

  const candidate = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const target = candidate.find(
    (node: { id?: string }) => node.id === "target-node",
  );
  assert.equal(sha256(target.func), candidateSha256);
  assert.equal(report.changedNodes, 1);
  assert.deepEqual(report.changedFields, ["func"]);
  assert.equal(report.invariants.nodeIdsUnchanged, true);
  assert.equal(report.invariants.wiresUnchanged, true);
  assert.equal(report.invariants.httpRoutesUnchanged, true);
  assert.deepEqual(candidate[1], flow[1]);
  assert.deepEqual(candidate[3], flow[3]);
});

test("guarded candidate builder fails closed on node identity mismatch", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lk-nodered-rating-recovery-fail-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, "report.json");
  const oldFunction = "return msg;";
  const inputBody = JSON.stringify([{
    id: "target-node",
    type: "function",
    name: "Unexpected function",
    func: oldFunction,
    wires: [],
  }]);
  fs.writeFileSync(inputPath, inputBody);

  const run = spawnSync(process.execPath, [
    patcherPath,
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--expected-node-id", "target-node",
    "--expected-node-type", "function",
    "--expected-node-name", "Recalculate ratings & totals",
    "--expected-sha256", sha256(oldFunction),
    "--expected-flow-sha256", sha256(inputBody),
  ], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Node identity mismatch/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
});

test("guarded candidate builder fails closed on function preimage mismatch", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lk-nodered-rating-recovery-preimage-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, "report.json");
  const inputBody = JSON.stringify([{
    id: "target-node",
    type: "function",
    name: "Recalculate ratings & totals",
    func: "return msg;",
    wires: [],
  }]);
  fs.writeFileSync(inputPath, inputBody);

  const run = spawnSync(process.execPath, [
    patcherPath,
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--expected-node-id", "target-node",
    "--expected-node-type", "function",
    "--expected-node-name", "Recalculate ratings & totals",
    "--expected-sha256", sha256("different preimage"),
    "--expected-flow-sha256", sha256(inputBody),
  ], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Preimage mismatch/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
});

test("guarded candidate builder rejects drift in an adjacent node", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lk-nodered-rating-recovery-flow-drift-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, "report.json");
  const oldFunction = "return msg;";
  const baselineFlow = [
    {
      id: "target-node",
      type: "function",
      name: "Recalculate ratings & totals",
      func: oldFunction,
      wires: [["sibling-node"]],
    },
    {
      id: "sibling-node",
      type: "function",
      name: "Original sibling",
      func: "return msg;",
      wires: [],
    },
  ];
  const baselineBody = JSON.stringify(baselineFlow);
  const driftedFlow = structuredClone(baselineFlow);
  driftedFlow[1].name = "Drifted sibling";
  fs.writeFileSync(inputPath, JSON.stringify(driftedFlow));

  const run = spawnSync(process.execPath, [
    patcherPath,
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--expected-node-id", "target-node",
    "--expected-node-type", "function",
    "--expected-node-name", "Recalculate ratings & totals",
    "--expected-sha256", sha256(oldFunction),
    "--expected-flow-sha256", sha256(baselineBody),
  ], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Flow preimage mismatch/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
});

test("guarded candidate builder rejects symlink and hardlink aliases", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lk-nodered-rating-recovery-alias-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, "report.json");
  const oldFunction = "return msg;";
  const inputBody = JSON.stringify([{
    id: "target-node",
    type: "function",
    name: "Recalculate ratings & totals",
    func: oldFunction,
    wires: [],
  }]);
  fs.writeFileSync(inputPath, inputBody);
  fs.symlinkSync(inputPath, outputPath);
  fs.linkSync(inputPath, reportPath);

  const run = spawnSync(process.execPath, [
    patcherPath,
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--expected-node-id", "target-node",
    "--expected-node-type", "function",
    "--expected-node-name", "Recalculate ratings & totals",
    "--expected-sha256", sha256(oldFunction),
    "--expected-flow-sha256", sha256(inputBody),
  ], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /same file or inode/);
  assert.equal(fs.readFileSync(inputPath, "utf8"), inputBody);
});

test("report write failure leaves no published candidate", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lk-nodered-rating-recovery-atomic-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, `${"r".repeat(260)}.json`);
  const oldFunction = "return msg;";
  const inputBody = JSON.stringify([{
    id: "target-node",
    type: "function",
    name: "Recalculate ratings & totals",
    func: oldFunction,
    wires: [],
  }]);
  fs.writeFileSync(inputPath, inputBody);

  const run = spawnSync(process.execPath, [
    patcherPath,
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--expected-node-id", "target-node",
    "--expected-node-type", "function",
    "--expected-node-name", "Recalculate ratings & totals",
    "--expected-sha256", sha256(oldFunction),
    "--expected-flow-sha256", sha256(inputBody),
  ], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
});
