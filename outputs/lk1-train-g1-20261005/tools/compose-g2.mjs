// Compose the G2 candidate on G1's postimage and report the derived pins.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { composeLk1TrainG2Artifacts } = await import(path.join(ROOT, "scripts/patch_live_lk1_train_g2_20261005.mjs"));

const source = process.argv[2];
const outDir = process.argv[3];
const assertPostimages = process.argv[4] !== "--pending";
const g1Bytes = fs.readFileSync(source);
const built = composeLk1TrainG2Artifacts(g1Bytes, { assertPostimages });
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(outDir, "g2-candidate.flow.json"), built.candidateBytes, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "g2-contract.json"), JSON.stringify(built.contract, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({
  sourceSha256: built.sourceSha256,
  candidateSha256: built.candidateSha256,
  changes: built.changes,
  evaluator: built.evaluator,
  preview: built.preview,
}, null, 2));
