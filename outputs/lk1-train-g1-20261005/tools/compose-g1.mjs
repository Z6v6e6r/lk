// Compose the G1 candidate and report the derived pins. Reads the read-only 147 snapshot from an
// external path; writes only inside this worktree.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");

const source = process.argv[2];
const outDir = process.argv[3];
const assertPostimages = process.argv[4] !== "--pending";
const { composeLk1TrainG1Artifacts, LK1_TRAIN_G1_TARGET, LK1_TRAIN_G1_CONTINUATION_SHA256 } =
  await import(path.join(ROOT, "scripts/patch_live_lk1_train_g1_20261005.mjs"));

const liveBytes = fs.readFileSync(source);
const built = composeLk1TrainG1Artifacts(liveBytes, { assertPostimages });
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(outDir, "g1-candidate.flow.json"), built.candidateBytes, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "g1-contract.json"), JSON.stringify(built.contract, null, 2) + "\n", { mode: 0o600 });
const result = {
  sourceSha256: built.sourceSha256,
  sourceNodeCount: built.flow.length,
  candidateSha256: built.candidateSha256,
  gatewayFuncBefore: LK1_TRAIN_G1_TARGET.liveFuncSha256,
  gatewayFuncAfter: built.changes[0].func.afterSha256,
  gatewayInitializeBefore: LK1_TRAIN_G1_TARGET.liveInitializeSha256,
  gatewayInitializeAfter: built.changes[0].initialize.afterSha256,
  usageBlockBefore: built.gateway.usageBlockBeforeSha256,
  usageBlockAfter: built.gateway.usageBlockSha256,
  continuationSha256: LK1_TRAIN_G1_CONTINUATION_SHA256,
  markers: built.gateway,
};
console.log(JSON.stringify(result, null, 2));
