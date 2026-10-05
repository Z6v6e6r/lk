// Compose the G1 ordered-rollback candidate (plan-rules writer reverted) on the G1 postimage.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { composeLk1TrainG1RevertArtifacts } = await import(path.join(ROOT, "scripts/patch_live_lk1_train_g1_20261005.mjs"));
const built = composeLk1TrainG1RevertArtifacts(fs.readFileSync(process.argv[2]));
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(outDir, "g1-revert-candidate.flow.json"), built.candidateBytes, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "g1-revert-contract.json"), JSON.stringify(built.contract, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256, changes: built.changes }, null, 2));
