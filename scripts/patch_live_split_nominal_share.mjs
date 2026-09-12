#!/usr/bin/env node
/**
 * Focused candidate builder for the split "no fabricated participant share" change.
 *
 * The live split nodes carry an older generation than the tracked sources, so this
 * patcher applies only the reviewed delta to the verified live bodies instead of
 * replacing whole function bodies (which would ship unrelated newer work).
 *
 * Usage:
 *   node scripts/patch_live_split_nominal_share.mjs \
 *     --workspace /absolute/verified/workspace \
 *     --output /absolute/new-dir/source.flow.json \
 *     --report /absolute/new-dir/receipt.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));

const JOIN_OLD = `const defaultShareAmount = roundMoney(oneTimeBaseAmount / Math.max(shareCount, 1))
  ?? (shareCount === 2 ? 5000 : 2500);
const shareAmount =
  (totalAmount !== null && totalAmount > 0
    ? roundMoney(totalAmount / Math.max(shareCount, 1))
    : null)
  ?? (
    bodyShareAmount !== null
      ? (resolveShareAmount(bodyShareAmount, durationMinutes, body.shareAmountIncludesDuration === true) ?? defaultShareAmount)
      : storedShareAmount ?? resolveShareAmount(defaultShareAmount, durationMinutes, false) ?? defaultShareAmount
  );`;
const JOIN_NEW = `// The nominal 10 000 / shareCount fallback is never fabricated: without a stored,
// requested or court-proven amount the share stays unresolved and the router fails
// closed before any Viva mutation (\`SPLIT_EXACT_PRICE_NOT_VERIFIED\`).
const shareAmount =
  (totalAmount !== null && totalAmount > 0
    ? roundMoney(totalAmount / Math.max(shareCount, 1))
    : null)
  ?? (
    bodyShareAmount !== null
      ? resolveShareAmount(bodyShareAmount, durationMinutes, body.shareAmountIncludesDuration === true)
      : storedShareAmount
  );`;

const CREATE_OLD = `const defaultShareAmount = roundMoney(oneTimeBaseAmount / Math.max(shareCount, 1))
  ?? (shareCount === 2 ? 5000 : 2500);
const resolvedShareAmountFromTotal =
  totalAmount !== null && totalAmount > 0
    ? roundMoney(totalAmount / Math.max(shareCount, 1))
    : null;
const shareAmount = resolvedShareAmountFromTotal
  ?? resolveShareAmount(
    toNumber(body.shareAmount) ?? defaultShareAmount,
    durationMinutes,
    body.shareAmountIncludesDuration === true,
  )
  ?? defaultShareAmount;`;
const CREATE_NEW = `const resolvedShareAmountFromTotal =
  totalAmount !== null && totalAmount > 0
    ? roundMoney(totalAmount / Math.max(shareCount, 1))
    : null;
// No nominal fallback: the router proves the exact court price for one-time payment
// and the campaign policy for subscription payment, otherwise the request fails closed.
const shareAmount = resolvedShareAmountFromTotal
  ?? (toNumber(body.shareAmount) !== null
    ? resolveShareAmount(
      toNumber(body.shareAmount),
      durationMinutes,
      body.shareAmountIncludesDuration === true,
    )
    : null);`;

const ROUTER_SHARE_OLD = `    const shareAmount = Math.max(0, toNumber(ctx.shareAmount) ?? 0);`;
const ROUTER_SHARE_NEW = `    // A subscription write-off carries no money; when no price was ever established
    // report no amount at all instead of fabricating the nominal 10 000 / shareCount.
    const resolvedShareAmount = toNumber(ctx.shareAmount);
    const shareAmount = resolvedShareAmount !== null && resolvedShareAmount > 0
      ? resolvedShareAmount
      : null;`;

const ROUTER_MINOR_OLD = `    ctx.shareAmountMinor = Math.max(0, Math.round(shareAmount * 100));`;
const ROUTER_MINOR_NEW = `    ctx.shareAmountMinor = shareAmount === null ? null : Math.max(0, Math.round(shareAmount * 100));`;

export const LIVE_SPLIT_NOMINAL_SHARE_CONTRACT = Object.freeze({
  sourceFlowSha256: "e5d643518373698679ad3a209d94db66877de654154a215681a368ac2e5ec332",
  nodeCount: 4799,
  httpRouteCount: 219,
  targets: Object.freeze([
    Object.freeze({
      id: "f3f9a60354d394da",
      name: "Prepare split game payment",
      type: "function",
      tabId: "4b91e2a2413688db",
      outputs: 4,
      liveFuncSha256: "6f7d6ec86432f5f3a50d0eb080df8847954841a9fc4637d79cf58fb2742fd689",
      replacements: Object.freeze([[CREATE_OLD, CREATE_NEW]]),
    }),
    Object.freeze({
      id: "e92e68bf3f08a70c",
      name: "Prepare split join payment",
      type: "function",
      tabId: "4b91e2a2413688db",
      outputs: 4,
      liveFuncSha256: "1360e9a049c34195b536aec34c1bf7bced0d0c21c02db6b68a6ae85a4ea7095c",
      replacements: Object.freeze([[JOIN_OLD, JOIN_NEW]]),
    }),
    Object.freeze({
      id: "8f7bd5b482fe9763",
      name: "Route Viva split payment",
      type: "function",
      tabId: "4b91e2a2413688db",
      outputs: 5,
      liveFuncSha256: "53c4f6ab309b4287eaded6c6d16a9c0e34f47c8eac625c58bdf423acfb083d42",
      replacements: Object.freeze([
        [ROUTER_SHARE_OLD, ROUTER_SHARE_NEW],
        [ROUTER_MINOR_OLD, ROUTER_MINOR_NEW],
      ]),
    }),
  ]),
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

/**
 * Applies reviewed literal replacements to one live function body. Every anchor must
 * match exactly once and must actually change the body: any drift fails closed so a
 * partially applied candidate can never be published.
 */
export function applySplitReplacements(bodySource, replacements) {
  let next = bodySource;
  for (const [from, to] of replacements) {
    const occurrences = next.split(from).length - 1;
    if (occurrences !== 1) {
      fail(`Replacement anchor matched ${occurrences} times`);
    }
    next = next.replace(from, to);
  }
  if (next === bodySource) fail("Patch produced no change");
  return next;
}

function snapshotInvariants(flow) {
  const ids = flow.map((node) => node?.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim())) fail("Flow contains a node without a valid id");
  if (new Set(ids).size !== ids.length) fail("Flow contains duplicate node ids");
  return {
    nodeCount: flow.length,
    httpRouteCount: flow.filter((node) => node?.type === "http in").length,
    wires: flow.map((node) => ({ id: node.id, outputs: node.outputs ?? null, wires: node.wires ?? null })),
    bodies: flow.map((node) => ({ id: node.id, funcSha256: sha256(node.func ?? "") })),
  };
}

export function applySplitNominalSharePatch(flow) {
  if (!Array.isArray(flow)) fail("Node-RED source must be a JSON array");
  const before = snapshotInvariants(flow);
  if (before.nodeCount !== LIVE_SPLIT_NOMINAL_SHARE_CONTRACT.nodeCount) {
    fail(`Live node count drifted: ${before.nodeCount}`);
  }
  if (before.httpRouteCount !== LIVE_SPLIT_NOMINAL_SHARE_CONTRACT.httpRouteCount) {
    fail(`Live http-route count drifted: ${before.httpRouteCount}`);
  }

  const candidate = flow.map((node) => ({ ...node }));
  const changedNodes = [];

  for (const target of LIVE_SPLIT_NOMINAL_SHARE_CONTRACT.targets) {
    const matches = candidate.filter((node) => node?.id === target.id);
    if (matches.length !== 1) fail(`Expected exactly one node ${target.id}`);
    const node = matches[0];
    if (node.type !== target.type || node.name !== target.name
      || node.outputs !== target.outputs || node.z !== target.tabId) {
      fail(`Node ${target.id} identity/topology mismatch`);
    }
    const liveFunc = typeof node.func === "string" ? node.func : "";
    if (sha256(liveFunc) !== target.liveFuncSha256) {
      fail(`Node ${target.id} live body does not match the reviewed preimage`);
    }
    const next = applySplitReplacements(liveFunc, target.replacements);
    node.func = next;
    changedNodes.push({
      id: target.id,
      name: target.name,
      fromSha256: target.liveFuncSha256,
      toSha256: sha256(next),
      replacements: target.replacements.length,
    });
  }

  const after = snapshotInvariants(candidate);
  const changedIds = new Set(changedNodes.map((item) => item.id));
  const untouchedBodiesChanged = after.bodies.some((entry, index) => (
    !changedIds.has(entry.id) && entry.funcSha256 !== before.bodies[index].funcSha256
  ));
  if (untouchedBodiesChanged) fail("A non-target function body changed");
  if (JSON.stringify(after.wires) !== JSON.stringify(before.wires)) fail("Wiring changed");
  if (after.nodeCount !== before.nodeCount) fail("Node count changed");
  if (after.httpRouteCount !== before.httpRouteCount) fail("http-route count changed");

  return {
    candidate,
    changedNodes,
    invariants: {
      nodeCount: after.nodeCount,
      httpRouteCount: after.httpRouteCount,
      changedFunctionBodies: changedNodes.length,
      untouchedFunctionBodiesChanged: 0,
      wiringChanged: false,
    },
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicationPaths(outputArg, reportArg, workspace) {
  const output = path.resolve(outputArg);
  const report = path.resolve(reportArg);
  if (path.resolve(outputArg) === path.resolve(reportArg)) fail("Output and report must be distinct");
  const directory = path.dirname(output);
  if (path.dirname(report) !== directory) fail("Output and report must share one new publication directory");
  const parentArg = path.dirname(directory);
  if (fs.existsSync(directory) || fs.lstatSync(parentArg).isSymbolicLink()) {
    fail("Publication directory must not already exist or use a symlink parent");
  }
  const parent = fs.realpathSync(parentArg);
  const canonicalDirectory = path.join(parent, path.basename(directory));
  if (canonicalDirectory !== directory || output !== outputArg || report !== reportArg) {
    fail("Output and report paths must be canonical");
  }
  if (isWithin(REPO_ROOT, directory)) fail("Publication directory must stay outside the repository");
  if (isWithin(path.join(workspace, "input"), directory)) fail("Publication directory must not alias verified input");
  return { directory, parent, output, report, stagePrefix: `.${path.basename(directory)}.nominal-share-stage-` };
}

function writePrivate(filePath, value) {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function publishSplitNominalShareCandidate({ workspace, output, report }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== LIVE_SPLIT_NOMINAL_SHARE_CONTRACT.sourceFlowSha256) {
    fail("Live flow SHA does not match the reviewed split preimage");
  }
  const paths = publicationPaths(output, report, verified.workspace);
  const result = applySplitNominalSharePatch(verified.source);
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`, "utf8");
  const candidateSha256 = sha256(candidateBytes);
  const receipt = {
    formatVersion: 1,
    ok: true,
    mutationPerformed: false,
    sourceSha256: verified.sourceSha256,
    candidateSha256,
    changedNodeCount: result.changedNodes.length,
    changedNodes: result.changedNodes,
    invariants: result.invariants,
  };
  const stage = path.join(paths.parent, `${paths.stagePrefix}${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    writePrivate(path.join(stage, path.basename(paths.output)), candidateBytes);
    writePrivate(path.join(stage, path.basename(paths.report)), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
    fs.renameSync(stage, paths.directory);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  console.log(`sourceSha256=${verified.sourceSha256}`);
  console.log(`candidateSha256=${candidateSha256}`);
  console.log(`nodeCount=${result.invariants.nodeCount}`);
  console.log(`httpRouteCount=${result.invariants.httpRouteCount}`);
  console.log(`changedNodeCount=${result.changedNodes.length}`);
  return receipt;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    values[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.workspace || !args.output || !args.report) {
      throw new Error("--workspace, --output and --report are required");
    }
    publishSplitNominalShareCandidate({
      workspace: args.workspace,
      output: path.resolve(args.output),
      report: path.resolve(args.report),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
