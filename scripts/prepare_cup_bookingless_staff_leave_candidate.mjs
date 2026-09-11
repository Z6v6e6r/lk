#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  buildFunctionOnlyContract,
  validateFunctionOnlyContract,
  sha256,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

// Function-only candidate for the CUP booking-less staff removal. The three
// bodies below are the only reviewed change; every pin is tied to one exact
// live preimage and the guarded builder refuses any drift.
export const SOURCE_SHA256 = "2ace2b60d0e246e84d5b9a542f6022ea1f7788c945dd855339e0ff0e47c09438";
export const EXPECTED_NODE_COUNT = 4799;
export const EXPECTED_HTTP_ROUTE_COUNT = 219;
export const TAB_ID = "4b91e2a2413688db";
export const TAB_LABEL = "LK Games";
export const DEPLOYMENT_ID = "cup-bookingless-staff-leave-20260911";
export const TARGETS = Object.freeze([
  {
    id: "lk_staff_player_leave_prepare_20260812",
    name: "Authorize CUP staff leave command",
    file: "fn_staff_player_leave_prepare.js",
    outputs: 2,
    liveSha256: "757ba258f19f755c1724c8efa220a6a9271baa9a6e6c49111ce61feeeabf8053",
    candidateSha256: "302b4c2982e72d3253930cf1fedffa1c6a35a8464d21698fb9306a0c9c441b80",
  },
  {
    id: "lk_staff_player_leave_authorize_20260812",
    name: "Bind CUP staff leave to active membership",
    file: "fn_staff_player_leave_authorize.js",
    outputs: 2,
    liveSha256: "faed3e292041d954c43939ac0c0f14a78fb45ddf8bf0a84cd931c15bb0db3751",
    candidateSha256: "21b49b991112ec559295a9ce5764a33ee70b324e660490948b91bfacdf98241d",
  },
  {
    id: "lk_split_leave_game_update_build_20260801",
    name: "Build split leave game CAS",
    file: "fn_split_leave_game_update.js",
    outputs: 3,
    liveSha256: "cbbba14fd7f24d63f7c955d3f1fc65fff7e546c2e620606e114d9540d8131766",
    candidateSha256: "e1bce1a4476e76f21b72ba94b98dc2fd515ce7cff343336ce63c05e0435d67ac",
  },
]);

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "nodered_games_nodes");
const fail = (message) => {
  throw new Error(message);
};
const readTrackedSource = (file) => fs.readFileSync(path.join(SOURCE_DIR, file), "utf8");

export function buildCupBookinglessStaffLeaveCandidate(source, readSource = readTrackedSource) {
  if (!Array.isArray(source)) fail("Live Node-RED source must be an array");
  if (source.length !== EXPECTED_NODE_COUNT) fail("Live Node-RED node count mismatch");
  if (source.filter((node) => node.type === "http in").length !== EXPECTED_HTTP_ROUTE_COUNT) {
    fail("Live Node-RED HTTP route count mismatch");
  }
  const tab = source.filter((node) => node.id === TAB_ID);
  if (
    tab.length !== 1
    || tab[0].type !== "tab"
    || tab[0].label !== TAB_LABEL
    || tab[0].disabled !== false
  ) {
    fail("LK Games tab contract mismatch");
  }

  const flow = structuredClone(source);
  const beforeById = new Map(source.map((node) => [node.id, node]));
  const changes = [];
  for (const target of TARGETS) {
    const nodes = flow.filter((node) => node.id === target.id);
    if (nodes.length !== 1) fail(`Expected exact Node-RED node ${target.id}`);
    const node = nodes[0];
    if (
      node.type !== "function"
      || node.z !== TAB_ID
      || node.name !== target.name
      || node.outputs !== target.outputs
      || !Array.isArray(node.wires)
      || node.wires.length !== target.outputs
    ) {
      fail(`Node contract mismatch for ${target.id}`);
    }
    if (sha256(String(node.func || "")) !== target.liveSha256) {
      fail(`Live preimage changed for ${target.id}`);
    }
    const nextSource = readSource(target.file);
    if (sha256(nextSource) !== target.candidateSha256) {
      fail(`Tracked candidate source changed for ${target.file}`);
    }
    new vm.Script(`(function(msg,node,context,flow,global,env){\n${nextSource}\n})`);
    node.func = nextSource;
    const before = beforeById.get(target.id);
    const changedFields = [...new Set([...Object.keys(before), ...Object.keys(node)])]
      .filter((key) => !isDeepStrictEqual(before[key], node[key]));
    if (!isDeepStrictEqual(changedFields, ["func"])) {
      fail(`Unexpected fields changed for ${target.id}: ${changedFields.join(",")}`);
    }
    changes.push({ id: target.id, name: target.name, file: target.file, changedFields: ["func"] });
  }

  const changedNodes = flow.filter((node) => !isDeepStrictEqual(beforeById.get(node.id), node));
  if (
    changedNodes.length !== TARGETS.length
    || changedNodes.some((node) => !TARGETS.some((target) => target.id === node.id))
  ) {
    fail("Candidate change budget mismatch");
  }
  const byId = new Map(flow.map((node) => [node.id, node]));
  if (byId.size !== flow.length) fail("Candidate contains duplicate node ids");
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of flow) {
    for (const wire of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!byId.has(wire)) brokenWires += 1;
    }
    if ((node.type === "link in" || node.type === "link out") && Array.isArray(node.links)) {
      for (const link of node.links) if (!byId.has(link)) brokenLinks += 1;
    }
  }
  if (brokenWires !== 0 || brokenLinks !== 0) fail("Candidate graph is inconsistent");
  if (flow.filter((node) => node.type === "http in").length !== EXPECTED_HTTP_ROUTE_COUNT) {
    fail("Candidate changed HTTP routes");
  }

  return {
    flow,
    changes,
    stats: {
      nodeCount: flow.length,
      httpRouteCount: EXPECTED_HTTP_ROUTE_COUNT,
      brokenWires,
      brokenLinks,
    },
  };
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export function runCupBookinglessStaffLeaveBuild(workspace) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== SOURCE_SHA256) {
    fail("Live Node-RED source SHA changed; pull a fresh preimage and review before rebuilding");
  }
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const { flow, changes, stats } = buildCupBookinglessStaffLeaveCandidate(verified.source);
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, "utf8");
  const allowedNodeIds = TARGETS.map((target) => target.id);
  const contract = buildFunctionOnlyContract({
    liveBytes,
    candidateBytes,
    deploymentId: DEPLOYMENT_ID,
    allowedNodeIds,
  });
  validateFunctionOnlyContract({ liveBytes, candidateBytes, contract });
  const reverse = buildFunctionOnlyContract({
    liveBytes: candidateBytes,
    candidateBytes: liveBytes,
    deploymentId: DEPLOYMENT_ID,
    allowedNodeIds,
  });
  validateFunctionOnlyContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: reverse });

  const output = path.join(verified.workspace, "build-cup-bookingless-staff-leave");
  fs.mkdirSync(output, { mode: 0o700 });
  const report = {
    caseId: DEPLOYMENT_ID,
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(candidateBytes),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: stats.nodeCount,
    httpRouteCount: stats.httpRouteCount,
    brokenWireCount: stats.brokenWires,
    brokenLinkCount: stats.brokenLinks,
    changedNodes: changes,
    contractSha256: sha256(Buffer.from(`${JSON.stringify(contract, null, 2)}\n`)),
    deploymentPerformed: false,
  };
  writePrivateJson(path.join(output, "candidate.flow.json"), flow);
  writePrivateJson(path.join(output, "contract.json"), contract);
  writePrivateJson(path.join(output, "structural-reverse.contract.json"), reverse);
  writePrivateJson(path.join(output, "report.json"), report);
  return report;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const workspaceIndex = argv.indexOf("--workspace");
  const workspace = workspaceIndex === -1 ? null : argv[workspaceIndex + 1];
  if (!workspace) {
    process.stderr.write("Usage: --workspace <fresh-private-live-workspace>\n");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(runCupBookinglessStaffLeaveBuild(workspace), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
