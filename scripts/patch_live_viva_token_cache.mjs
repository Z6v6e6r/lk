#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(ROOT, "scripts/nodered_games_nodes");
const DEFAULT_FLOW_SHA256 = "d9ae9ef519f5f1e1bc474ebd7aff955b20721af3467c92f079cf6f68dc26c76a";

const targets = [
  {
    id: "880a87e38e41c38e",
    name: "Get Viva token (live)",
    file: "fn_live_ratings_get_token.js",
    beforeFuncSha256: "5310c608ff006d49570dc9b80f1cd2e12c6bd405571e228e46607bbd2bb30235",
    outputs: 3,
    wires: [["1fd1dcd764da81fc"], ["4e8f1e4487c2a7e9"], ["d512f52a73f1427a"]],
  },
  {
    id: "773fd272d093c306",
    name: "Store Viva token (live)",
    file: "fn_live_ratings_store_token.js",
    beforeFuncSha256: "5d67f75f846462635edb79b579cfae115cd7f0352ee99691e5579c34459d5944",
    outputs: 3,
    wires: [["1fd1dcd764da81fc"], ["d512f52a73f1427a"], ["89fa382fe1de52e2"]],
  },
  {
    id: "f3f9a60354d394da",
    name: "Prepare split game payment",
    file: "fn_split_create_prepare.js",
    beforeFuncSha256: "a62d72cdaec7bf50f023bf1fcebfb71453df5b02d638cf9793c63a98b112ea8e",
    outputs: 3,
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"]],
    directRouterId: "8f7bd5b482fe9763",
  },
  {
    id: "e92e68bf3f08a70c",
    name: "Prepare split join payment",
    file: "fn_split_join_prepare.js",
    beforeFuncSha256: "bf241c1197090e52a01e5414a81675cc19279fcb26f9231bb15914561401cc17",
    outputs: 3,
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"]],
    directRouterId: "8f7bd5b482fe9763",
  },
  {
    id: "8f7bd5b482fe9763",
    name: "Route Viva split payment",
    file: "fn_split_router.js",
    beforeFuncSha256: "a311b8ddc6e7752ee87deb278b25ac2ddc8fb9af8b273deea66b07702ac571c8",
    outputs: 4,
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"], ["lk_subscription_booking_http_20260804"]],
  },
  {
    id: "bcc3dccf8d64f9bb",
    name: "Route split cleanup action",
    file: "fn_split_cleanup_router.js",
    beforeFuncSha256: "ef80ddb8930e7e9e9146b799ab8a986a40efd2f7af79e16c5e4124d05b359e26",
    outputs: 4,
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
    "Usage: node scripts/patch_live_viva_token_cache.mjs --input <flow.json> "
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
const before = structuredClone(flow);

const changed = [];
for (const target of targets) {
  const matches = flow.filter((node) => node?.id === target.id);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one node ${target.id}, found ${matches.length}`);
  }
  const node = matches[0];
  if (node.type !== "function" || node.name !== target.name) {
    throw new Error(`Node contract mismatch for ${target.id}`);
  }
  if (Number(node.outputs) !== target.outputs) {
    throw new Error(`Unexpected output count for ${target.id}: ${String(node.outputs)}`);
  }
  if (target.wires && !isDeepStrictEqual(node.wires, target.wires)) {
    throw new Error(`Unexpected wiring for ${target.id}`);
  }
  const beforeFuncSha256 = sha256(Buffer.from(String(node.func || ""), "utf8"));
  if (beforeFuncSha256 !== target.beforeFuncSha256) {
    throw new Error(
      `Function preimage mismatch for ${target.id}: expected ${target.beforeFuncSha256}, got ${beforeFuncSha256}`,
    );
  }
  const nextFunc = fs.readFileSync(path.join(FN_DIR, target.file), "utf8");
  if (/DEFAULT_TOKEN_REQUEST_BODY|KEY_TOKEN_REQUEST_BODY|default_inline|grant_type=password&client_id=/.test(nextFunc)) {
    throw new Error(`Candidate source ${target.file} contains forbidden inline credential material`);
  }
  node.func = nextFunc;
  if (target.directRouterId) {
    node.outputs = 4;
    node.wires = [...target.wires, [target.directRouterId]];
  }
  changed.push({
    id: target.id,
    name: target.name,
    file: target.file,
    beforeFuncSha256,
    afterFuncSha256: sha256(Buffer.from(nextFunc, "utf8")),
    changedFields: target.directRouterId ? ["func", "outputs", "wires"] : ["func"],
  });
}

const changedIds = new Set(changed.map((item) => item.id));
for (let index = 0; index < flow.length; index += 1) {
  if (changedIds.has(flow[index]?.id)) continue;
  if (!isDeepStrictEqual(flow[index], before[index])) {
    throw new Error(`Non-target node changed: ${String(flow[index]?.id)}`);
  }
}
const beforeRoutes = before.filter((node) => node?.type === "http in");
const afterRoutes = flow.filter((node) => node?.type === "http in");
if (!isDeepStrictEqual(beforeRoutes, afterRoutes)) throw new Error("HTTP routes changed");
if (flow.length !== before.length) throw new Error("Node count changed");

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
    nodeCountUnchanged: true,
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
