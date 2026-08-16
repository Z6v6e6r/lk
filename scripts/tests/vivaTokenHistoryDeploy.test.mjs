import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REVIEWED_LIVE_FLOW_SHA256,
  buildManagedEnvironment,
  validateDeploymentCandidate,
  validateLiveCredentialContract,
  validateManagedEnvironment,
} from "../nodered_viva_token_deploy/runtime_contract.mjs";

const BASE_SHA = "7ce25406de58d42ddd5cc20fb0b514de941c628d";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const baseline = (file) => {
  const result = spawnSync("git", ["show", `${BASE_SHA}:scripts/nodered_games_nodes/${file}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const makeReviewedFlow = () => {
  const flow = [
    {
      id: "880a87e38e41c38e", type: "function", name: "Get or request Viva token",
      outputs: 3, func: baseline("fn_live_ratings_get_token.js"),
      wires: [["1fd1d27e74608f5b"], ["4e8fc55bbbd25474"], ["d51215cddf288d9f"]],
    },
    {
      id: "773fd272d093c306", type: "function", name: "Store Viva token (live)",
      outputs: 3, func: baseline("fn_live_ratings_store_token.js"),
      wires: [["1fd1d27e74608f5b"], ["d51215cddf288d9f"], ["89f8508ef3f6a603"]],
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
      collection: "tournaments", operation: "find", maxTimeMS: "5000",
      wires: [["tournament_community_history_query_20260811"]],
    },
    {
      id: "tournament_community_history_query_20260811", type: "function", z: "tab-1",
      name: "Find tournament publications", func: "return msg;",
      wires: [["tournament_community_history_feed_20260811"]],
    },
    {
      id: "tournament_community_history_feed_20260811", type: "mongodb4", z: "tab-1",
      name: "Find active tournament publications", collection: "lk_community_feed",
      operation: "find", maxTimeMS: "5000",
      wires: [["tournament_community_history_attach_20260811"]],
    },
    {
      id: "tournament_community_history_attach_20260811", type: "function", z: "tab-1",
      name: "Attach published communities", func: "return msg;", wires: [["a57565a6ddbb532f"]],
    },
    { id: "a57565a6ddbb532f", type: "http response", z: "tab-1", name: "", wires: [] },
  ];
  for (const id of [
    "1fd1d27e74608f5b", "4e8fc55bbbd25474", "d51215cddf288d9f", "89f8508ef3f6a603",
    "ee7ba8cdd68bdf74", "802af8a1810db60f", "ef42932e1ba864b8", "lk_subscription_booking_http_20260804",
  ]) flow.push({ id, type: "debug", name: id, wires: [] });
  return flow;
};

const runPatcher = (script, input, output, report) => {
  const expected = sha256(fs.readFileSync(input));
  const result = spawnSync(process.execPath, [
    script, "--input", input, "--output", output, "--report", report,
    "--expected-flow-sha256", expected,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

test("reviewed service credential quorum produces a strict managed environment", () => {
  const flow = makeReviewedFlow();
  const credential = validateLiveCredentialContract(flow);
  const document = buildManagedEnvironment(flow);
  assert.deepEqual(validateManagedEnvironment(document), credential);
  assert.equal(document.formatVersion, 1);
  assert.equal(document.source, "reviewed-live-target-functions");
  assert.equal(REVIEWED_LIVE_FLOW_SHA256.length, 64);
});

test("combined token-cache and history candidate stays inside the reviewed change budget", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "viva-token-history-deploy-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const livePath = path.join(temp, "live.json");
  const tokenPath = path.join(temp, "token.json");
  const tokenReport = path.join(temp, "token-report.json");
  const candidatePath = path.join(temp, "candidate.json");
  const historyReport = path.join(temp, "history-report.json");
  const liveFlow = makeReviewedFlow();
  fs.writeFileSync(livePath, `${JSON.stringify(liveFlow, null, 2)}\n`);
  runPatcher("scripts/patch_live_viva_token_cache.mjs", livePath, tokenPath, tokenReport);
  runPatcher("scripts/patch_live_tournament_history_resilience.mjs", tokenPath, candidatePath, historyReport);
  const candidateFlow = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const result = validateDeploymentCandidate(liveFlow, candidateFlow);
  assert.equal(result.changedExistingNodeCount, 8);
  assert.equal(result.addedNodeCount, 3);

  const wireDrift = structuredClone(candidateFlow);
  wireDrift.find((node) => node.id === "f3f9a60354d394da").wires[0] = ["802af8a1810db60f"];
  assert.throws(() => validateDeploymentCandidate(liveFlow, wireDrift), /cached-token route mismatch/);

  const catchDrift = structuredClone(candidateFlow);
  catchDrift.find((node) => node.id === "tournament_history_storage_catch_20260816").scope = [];
  assert.throws(() => validateDeploymentCandidate(liveFlow, catchDrift), /added-node contract mismatch/);

  const limitDrift = structuredClone(candidateFlow);
  limitDrift.find((node) => node.id === "ddc581fde0073e34").limit = "2";
  assert.throws(() => validateDeploymentCandidate(liveFlow, limitDrift), /history limit mismatch/);
});

test("deploy entrypoint is explicit, backup-first, and has automatic postcheck rollback", () => {
  const wrapper = fs.readFileSync("scripts/deploy_nodered_viva_token_history_147.sh", "utf8");
  const remote = fs.readFileSync(
    "scripts/nodered_viva_token_deploy/deploy_viva_token_history_147_remote.mjs",
    "utf8",
  );
  assert.match(wrapper, /NODE_RED_VIVA_TOKEN_HISTORY_DEPLOY=CONFIRM_147/);
  assert.match(wrapper, /git fetch --quiet origin main/);
  assert.match(wrapper, /pull_nodered_source_from_147\.sh/);
  assert.match(wrapper, /rollback-flow --backup/);
  assert.match(remote, /flows-pre-viva-token-history-/);
  assert.match(remote, /runPm2\(\["restart", "node-red", "--update-env"\], managed\)/);
  assert.match(remote, /PM2 managed environment mismatch/);
  assert.doesNotMatch(wrapper + remote, /echo .*VIVA_SERVICE_PASSWORD|console\.log\(.*password/i);
  assert.doesNotMatch(wrapper, /rm\s+-rf/);
});
