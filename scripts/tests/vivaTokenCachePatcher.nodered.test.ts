import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE_SHA = "7ce25406de58d42ddd5cc20fb0b514de941c628d";
const patcher = "scripts/patch_live_viva_token_cache.mjs";
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const baseline = (file: string) => {
  const result = spawnSync("git", [
    "show",
    `${BASE_SHA}:scripts/nodered_games_nodes/${file}`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const makeFlow = () => ([
  {
    id: "880a87e38e41c38e", type: "function", name: "Get Viva token (live)",
    outputs: 3, func: baseline("fn_live_ratings_get_token.js"),
    wires: [["1fd1dcd764da81fc"], ["4e8f1e4487c2a7e9"], ["d512f52a73f1427a"]],
  },
  {
    id: "773fd272d093c306", type: "function", name: "Store Viva token (live)",
    outputs: 3, func: baseline("fn_live_ratings_store_token.js"),
    wires: [["1fd1dcd764da81fc"], ["d512f52a73f1427a"], ["89fa382fe1de52e2"]],
  },
  {
    id: "f3f9a60354d394da", type: "function", name: "Prepare split game payment",
    outputs: 3, func: baseline("fn_split_create_prepare.js"),
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"]],
  },
  {
    id: "e92e68bf3f08a70c", type: "function", name: "Prepare split join payment",
    outputs: 3, func: baseline("fn_split_join_prepare.js"),
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"]],
  },
  {
    id: "8f7bd5b482fe9763", type: "function", name: "Route Viva split payment",
    outputs: 4, func: baseline("fn_split_router.js"),
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"], ["lk_subscription_booking_http_20260804"]],
  },
  {
    id: "bcc3dccf8d64f9bb", type: "function", name: "Route split cleanup action",
    outputs: 4, func: baseline("fn_split_cleanup_router.js"), wires: [[], [], [], []],
  },
  { id: "route-1", type: "http in", method: "get", url: "/unchanged", wires: [[]] },
]);

const run = (flow: unknown[], expectedBody?: string) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "viva-token-cache-patch-"));
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

test("guarded token-cache patch replaces exactly six functions and two wirings", (t) => {
  const result = run(makeFlow());
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(fs.readFileSync(result.input, "utf8"), result.body);
  const candidate = JSON.parse(fs.readFileSync(result.output, "utf8"));
  const report = JSON.parse(fs.readFileSync(result.report, "utf8"));
  assert.equal(report.changed.length, 6);
  assert.deepEqual(
    report.changed.filter((item: any) => item.changedFields.includes("wires")).map((item: any) => item.id),
    ["f3f9a60354d394da", "e92e68bf3f08a70c"],
  );
  for (const id of ["f3f9a60354d394da", "e92e68bf3f08a70c"]) {
    const node = candidate.find((item: any) => item.id === id);
    assert.equal(node.outputs, 4);
    assert.deepEqual(node.wires[3], ["8f7bd5b482fe9763"]);
  }
  assert.equal(candidate.find((item: any) => item.id === "route-1").url, "/unchanged");
  assert.equal(fs.statSync(result.output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.report).mode & 0o777, 0o600);
});

test("guarded token-cache patch refuses whole-flow drift", (t) => {
  const baselineFlow = makeFlow();
  const baselineBody = `${JSON.stringify(baselineFlow, null, 2)}\n`;
  const drifted = makeFlow();
  (drifted.at(-1) as any).url = "/drifted";
  const result = run(drifted, baselineBody);
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  assert.notEqual(result.result.status, 0);
  assert.match(result.result.stderr, /Flow preimage mismatch/);
  assert.equal(fs.existsSync(result.output), false);
  assert.equal(fs.existsSync(result.report), false);
});
