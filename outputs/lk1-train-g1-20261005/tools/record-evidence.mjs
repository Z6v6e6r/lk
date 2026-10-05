// Record the reviewable evidence for the G1/G2 candidates: shas, changed nodes/fields, contract,
// markers. No flow bytes are written (the candidates are reproducible from the generation scripts
// plus the read-only snapshot).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = process.argv[2] ?? "/private/tmp/lk1-train-147-prep/input/source.flow.json";
const {
  LK1_TRAIN_G1_POSTIMAGE_SHA256, LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256,
  composeLk1TrainG1Artifacts, composeLk1TrainG1RevertArtifacts, sha256,
} = await import(path.join(ROOT, "scripts/patch_live_lk1_train_g1_20261005.mjs"));
const { LK1_TRAIN_G2_POSTIMAGE_SHA256, composeLk1TrainG2Artifacts } =
  await import(path.join(ROOT, "scripts/patch_live_lk1_train_g2_20261005.mjs"));

const bytes = fs.readFileSync(SNAPSHOT);
const g1 = composeLk1TrainG1Artifacts(bytes);
const revert = composeLk1TrainG1RevertArtifacts(g1.candidateBytes);
const g2 = composeLk1TrainG2Artifacts(g1.candidateBytes);
if (g1.candidateSha256 !== LK1_TRAIN_G1_POSTIMAGE_SHA256
  || revert.candidateSha256 !== LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256
  || g2.candidateSha256 !== LK1_TRAIN_G2_POSTIMAGE_SHA256) {
  throw new Error("Evidence composition does not match the pinned postimages");
}
const evidence = {
  kind: "LK1_TRAIN_147_G1_G2_CANDIDATE_EVIDENCE",
  preparedAt: "2026-10-05",
  source: { sha256: sha256(bytes), nodeCount: g1.flow.length, path: SNAPSHOT },
  generations: [
    { id: "lk1-train-g1", candidateSha256: g1.candidateSha256,
      contractSha256: sha256(JSON.stringify(g1.contract)),
      changedNodes: g1.changes.map((row) => ({ id: row.id, fields: row.fields,
        func: row.func, initialize: row.initialize })),
      addedNodes: 0, contract: g1.contract, markers: g1.gateway },
    { id: "lk1-train-g1-revert", upstreamSha256: g1.candidateSha256, candidateSha256: revert.candidateSha256,
      changedNodes: revert.changes.map((row) => ({ id: row.id, fields: row.fields, initialize: row.initialize })),
      addedNodes: 0, contract: revert.contract },
    { id: "lk1-train-g2", upstreamSha256: g1.candidateSha256, candidateSha256: g2.candidateSha256,
      changedNodes: g2.changes.map((row) => ({ id: row.id, fields: row.fields, func: row.func })),
      addedNodes: 0, contract: g2.contract, evaluator: g2.evaluator, preview: g2.preview },
  ],
  validation: {
    exactGraphContract: "buildExactGraphContract + validateReviewedFlowContract passed for all three candidates",
    anchorUniqueness: "every delta anchor asserted exactly once before use (see pin-derivation.json)",
    failClosed: "wrong preimage sha, wrong node count, missing/duplicate anchor, wrong usage block or wrong postimage all refuse",
  },
};
fs.writeFileSync(path.join(HERE, "..", "candidate-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ g1: g1.candidateSha256, revert: revert.candidateSha256, g2: g2.candidateSha256 }, null, 2));
