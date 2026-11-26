import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { buildExactGraphContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const targets = [
  {
    id: "e656cff36a8cd210",
    hash: "08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f",
    file: "nodered_games_nodes/fn_create.js",
    start: "const isBookingConvertCategoryAllowed =",
    end: "const organizerNorm =",
  },
  {
    id: "organizer_handoff_20260913_patch_check",
    hash: "9ecea840937e0324545d0e55246184e9e51eb425639d35e606e405da235a0d5c",
    patch: addPaidBookingConversionPatchGuard,
  },
];

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

export function addPaidBookingConversionPatchGuard(body) {
  const anchor = 'if (Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt")';
  const fragment = fs.readFileSync(path.join(sourceDir,
    "nodered_organizer_handoff_nodes/paid_booking_conversion_patch_guard.js"), "utf8");
  if (body.split(anchor).length !== 2
    || body.includes("BOOKING_CONVERT_PAID_JOIN_UNAVAILABLE")
    || !fragment.includes("BOOKING_CONVERT_PAID_JOIN_UNAVAILABLE")) {
    throw new Error("Exact paid join PATCH guard anchor drift");
  }
  return body.replace(anchor, () => fragment + anchor);
}

function bounds(source, target) {
  const start = source.indexOf(target.start);
  const end = source.indexOf(target.end, start + target.start.length);
  if (start < 0 || end < 0 || source.indexOf(target.start, start + 1) >= 0) {
    throw new Error(`Missing unique guard anchors for ${target.id}`);
  }
  return [start, end];
}

function main() {
  if (process.argv.length !== 4) {
    throw new Error("Usage: node scripts/prepare_paid_booking_conversion_guard.mjs <fresh live workspace> <new deployment id>");
  }

  const { workspace, source, sourcePath } = verifyWorkspace(process.argv[2]);
  const deploymentId = process.argv[3];
  const candidate = structuredClone(source);
  for (const target of targets) {
    const node = candidate.find(({ id }) => id === target.id);
    if (node?.type !== "function" || typeof node.func !== "string"
      || crypto.createHash("sha256").update(node.func).digest("hex") !== target.hash) {
      throw new Error(`Reviewed guard preimage changed for ${target.id}`);
    }
    if (target.patch) {
      node.func = target.patch(node.func);
    } else {
      const proposed = fs.readFileSync(path.join(sourceDir, target.file), "utf8");
      const [start, end] = bounds(node.func, target);
      const [newStart, newEnd] = bounds(proposed, target);
      const guard = proposed.slice(newStart, newEnd);
      if (!guard.includes("BOOKING_CONVERT_PAID_JOIN_UNAVAILABLE")) {
        throw new Error(`Paid join guard source missing for ${target.id}`);
      }
      node.func = node.func.slice(0, start) + guard + node.func.slice(end);
    }
    new Function("msg", "env", "node", "flow", "global", node.func);
  }

  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  const contract = buildExactGraphContract({
    liveBytes: fs.readFileSync(sourcePath),
    candidateBytes,
    deploymentId,
    allowedChanges: targets.map(({ id }) => ({ id, fields: ["func"] })),
    allowedAdditionIds: [],
  });
  const output = path.join(workspace, "paid-booking-conversion-guard");
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, "candidate.flow.json"), candidateBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(output, "contract.json"), JSON.stringify(contract, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    changedFunctions: targets.map(({ id }) => id),
    sourceSha256: contract.sourceSha256,
    candidateSha256: contract.candidateSha256,
    nodeCount: contract.candidateNodeCount,
    httpInputCount: contract.httpInputCount,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
