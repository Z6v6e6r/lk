#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(ROOT, "scripts/nodered_games_nodes");
const DEFAULT_FLOW_SHA256 = "3c870102e2c77892571e66b1bbcee3c9675f5f09336b207af24eac17e831fd79";
const SCHEDULER_ID = "lk_split_cleanup_scheduler_20260822";

const targets = [
  {
    id: "8f7bd5b482fe9763",
    name: "Route Viva split payment",
    file: "fn_split_router.js",
    beforeFuncSha256: "4713fd6bf49f498cd51d80da37f1332dda6934c4e9f926afec0b2ffe1a1290ef",
    outputs: 5,
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"], ["lk_subscription_booking_http_20260804"], ["legacy_payment_confirm_canonical_prepare_20260816"]],
  },
  {
    id: "dcd649158bd8df8e",
    name: "Build split cleanup query",
    file: "fn_split_cleanup_query.js",
    beforeFuncSha256: "0f7434e9a7893d796062afafb54b42652687caa70f6e2f379f90690c907145db",
    outputs: 3,
    wires: [["67a1d32b321a2032"], ["dfaa7a139e9538c8"], ["ba322f367a4d4fcd"]],
  },
  {
    id: "9508f8e0ae8d282a",
    name: "Prepare split cleanup tasks",
    file: "fn_split_cleanup_prepare.js",
    beforeFuncSha256: "610f8a8f1f7254c2c72bedec5437c38e1f46a633b751286f8b2a0e8b24f93845",
    outputs: 3,
    wires: [["6172933891ac92e1"], ["dfaa7a139e9538c8"], ["ba322f367a4d4fcd"]],
  },
  {
    id: "bcc3dccf8d64f9bb",
    name: "Route split cleanup action",
    file: "fn_split_cleanup_router.js",
    beforeFuncSha256: "6aac80dba531ab882589bf87daad48a318106930128c908cf85b8e2680fbe677",
    outputs: 4,
    wires: [["41d9d40fefc3b1f3"], ["ed88ec81ce95b8b0"], ["e71d73fb91b0c3f0"], ["ba322f367a4d4fcd"]],
  },
  {
    id: "cdaa01626b742621",
    name: "Build split cleanup response",
    file: "fn_split_cleanup_response.js",
    beforeFuncSha256: "9743a5a1dad9ddafc943aef819a060e888431f9a8b9e1271ebc84ead9e344ad2",
    outputs: 2,
    wires: [["dfaa7a139e9538c8"], ["ba322f367a4d4fcd"]],
  },
];

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const inputPath = getArg("--input");
const outputPath = getArg("--output");
const reportPath = getArg("--report");
const expectedFlowSha256 = (getArg("--expected-flow-sha256") || DEFAULT_FLOW_SHA256).toLowerCase();
if (!inputPath || !outputPath || !reportPath || !/^[a-f0-9]{64}$/.test(expectedFlowSha256)) {
  throw new Error(
    "Usage: node scripts/patch_live_split_lifecycle_v2.mjs --input <flow.json> "
    + "--output <candidate.json> --report <report.json> [--expected-flow-sha256 <sha256>]",
  );
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalizePath = (filePath) => {
  const absolutePath = path.resolve(filePath);
  if (fs.existsSync(absolutePath)) return fs.realpathSync(absolutePath);
  return path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
};
const sameInode = (leftPath, rightPath) => {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const left = fs.statSync(leftPath);
  const right = fs.statSync(rightPath);
  return left.dev === right.dev && left.ino === right.ino;
};
const input = canonicalizePath(inputPath);
const output = canonicalizePath(outputPath);
const reportFile = canonicalizePath(reportPath);
if (
  input === output || input === reportFile || output === reportFile
  || sameInode(input, output) || sameInode(input, reportFile) || sameInode(output, reportFile)
) throw new Error("Input, output, and report paths must be distinct");
if (fs.existsSync(output) || fs.existsSync(reportFile)) {
  throw new Error("Output and report destinations must not already exist");
}

const inputBytes = fs.readFileSync(input);
const flowSha256 = sha256(inputBytes);
if (flowSha256 !== expectedFlowSha256) {
  throw new Error(`Flow preimage mismatch: expected ${expectedFlowSha256}, got ${flowSha256}`);
}
const flow = JSON.parse(inputBytes.toString("utf8"));
if (!Array.isArray(flow)) throw new Error("Flow must be a JSON array");
if (flow.some((node) => node?.id === SCHEDULER_ID)) throw new Error("Scheduler node already exists");
const before = structuredClone(flow);
const changed = [];

for (const target of targets) {
  const matches = flow.filter((node) => node?.id === target.id);
  if (matches.length !== 1) throw new Error(`Expected exactly one node ${target.id}, found ${matches.length}`);
  const node = matches[0];
  if (node.type !== "function" || node.name !== target.name) {
    throw new Error(`Node contract mismatch for ${target.id}`);
  }
  if (Number(node.outputs) !== target.outputs || !isDeepStrictEqual(node.wires, target.wires)) {
    throw new Error(`Output contract mismatch for ${target.id}`);
  }
  const beforeFuncSha256 = sha256(Buffer.from(String(node.func || ""), "utf8"));
  if (beforeFuncSha256 !== target.beforeFuncSha256) {
    throw new Error(
      `Function preimage mismatch for ${target.id}: expected ${target.beforeFuncSha256}, got ${beforeFuncSha256}`,
    );
  }
  const nextFunc = fs.readFileSync(path.join(FN_DIR, target.file), "utf8");
  if (/grant_type=password&client_id=|VIVA_SERVICE_PASSWORD\s*=\s*["'][^"']+["']/.test(nextFunc)) {
    throw new Error(`Candidate source ${target.file} contains forbidden inline credential material`);
  }
  node.func = nextFunc;
  changed.push({
    id: target.id,
    name: target.name,
    file: target.file,
    beforeFuncSha256,
    afterFuncSha256: sha256(Buffer.from(nextFunc, "utf8")),
    changedFields: ["func"],
  });
}

const cleanupQuery = flow.find((node) => node?.id === "dcd649158bd8df8e");
flow.push({
  id: SCHEDULER_ID,
  type: "inject",
  z: cleanupQuery.z,
  name: "Reconcile expired split payments",
  props: [
    {
      p: "_splitCleanupInternal",
      v: JSON.stringify({ source: "scheduler" }),
      vt: "json",
    },
  ],
  repeat: "120",
  crontab: "",
  once: true,
  onceDelay: 30,
  topic: "",
  payload: "",
  payloadType: "date",
  x: 190,
  y: 2080,
  wires: [[cleanupQuery.id]],
});
changed.push({
  id: SCHEDULER_ID,
  name: "Reconcile expired split payments",
  file: null,
  beforeFuncSha256: null,
  afterFuncSha256: null,
  changedFields: ["node_added"],
});

const changedIds = new Set(targets.map((item) => item.id));
for (let index = 0; index < before.length; index += 1) {
  if (changedIds.has(before[index]?.id)) continue;
  if (!isDeepStrictEqual(before[index], flow[index])) {
    throw new Error(`Non-target node changed: ${String(before[index]?.id)}`);
  }
}
const beforeRoutes = before.filter((node) => node?.type === "http in");
const afterRoutes = flow.filter((node) => node?.type === "http in");
if (!isDeepStrictEqual(beforeRoutes, afterRoutes)) throw new Error("HTTP routes changed");
if (flow.length !== before.length + 1) throw new Error("Unexpected node count delta");

const candidateText = `${JSON.stringify(flow, null, 2)}\n`;
const candidateSha256 = sha256(Buffer.from(candidateText, "utf8"));
const report = {
  ok: true,
  flowSha256,
  candidateSha256,
  expectedFlowSha256,
  inputPath: input,
  outputPath: output,
  changed,
  invariants: {
    existingNodeCountUnchanged: true,
    schedulerNodesAdded: 1,
    httpRoutesUnchanged: true,
    targetCount: changed.length,
    candidateNodeCount: flow.length,
  },
};
const tempPath = (destination) => path.join(
  path.dirname(destination),
  `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
);
const outputTemp = tempPath(output);
const reportTemp = tempPath(reportFile);
const removeIfPresent = (filePath) => {
  try { fs.unlinkSync(filePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
};
let outputPublished = false;
let reportPublished = false;
try {
  fs.writeFileSync(outputTemp, candidateText, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(reportTemp, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.linkSync(reportTemp, reportFile);
  reportPublished = true;
  fs.linkSync(outputTemp, output);
  outputPublished = true;
} catch (error) {
  if (outputPublished) removeIfPresent(output);
  if (reportPublished) removeIfPresent(reportFile);
  throw error;
} finally {
  removeIfPresent(outputTemp);
  removeIfPresent(reportTemp);
}
console.log(JSON.stringify(report, null, 2));
