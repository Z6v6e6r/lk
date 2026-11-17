#!/usr/bin/env node
/**
 * Собирает кандидат для guarded installer из живого flow и клонированного фрагмента.
 *
 * Кандидат = живой flow (в исходном порядке, байт-неизменные узлы) + узлы фрагмента
 * в конце. Контракт exact-graph разрешает только добавления, поэтому любое
 * случайное изменение живого узла ломает preflight, а не прод.
 *
 * Usage:
 *   node scripts/tenant_assemble_candidate.mjs \
 *     --live <source.flow.json> \
 *     --fragment <candidate.flow.json> \
 *     --out <final.flow.json> \
 *     --contract <contract.json> \
 *     --deployment-id <id>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildExactGraphContract as buildContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
};

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["live", "fragment", "out", "contract", "deployment-id"]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }

  const liveBytes = fs.readFileSync(path.resolve(args.live));
  const live = JSON.parse(liveBytes.toString("utf8"));
  const fragment = JSON.parse(fs.readFileSync(path.resolve(args.fragment), "utf8"));
  if (!Array.isArray(live) || !Array.isArray(fragment)) throw new Error("flow and fragment must be JSON arrays");

  const liveIds = new Set();
  for (const node of live) {
    if (typeof node?.id !== "string" || !node.id) throw new Error("live flow contains an invalid node");
    liveIds.add(node.id);
  }
  const additionIds = [];
  const seen = new Set();
  for (const node of fragment) {
    if (typeof node?.id !== "string" || !node.id) throw new Error("fragment contains an invalid node");
    if (liveIds.has(node.id)) throw new Error(`fragment reuses a live node id: ${node.id}`);
    if (seen.has(node.id)) throw new Error(`fragment has a duplicate node id: ${node.id}`);
    seen.add(node.id);
    additionIds.push(node.id);
  }

  // Живые узлы остаются ровно теми же объектами в том же порядке; фрагмент — в хвосте.
  const candidate = [...live, ...fragment];
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  const contract = buildContract({
    liveBytes,
    candidateBytes,
    deploymentId: args["deployment-id"],
    allowedChanges: [],
    allowedAdditionIds: additionIds,
    activationBoundary: null,
  });

  fs.writeFileSync(path.resolve(args.out), candidateBytes, { mode: 0o600 });
  fs.writeFileSync(path.resolve(args.contract), `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600, flag: "wx" });

  console.log(JSON.stringify({
    liveNodes: live.length,
    addedNodes: additionIds.length,
    candidateNodes: candidate.length,
    liveSha256: sha256(liveBytes),
    candidateSha256: sha256(candidateBytes),
    deploymentId: contract.deploymentId,
  }, null, 2));
};

if (process.argv[1] && process.argv[1].endsWith("tenant_assemble_candidate.mjs")) {
  main();
}
