// Build an immutable FPR-only release from an independently verified installed
// worker. This never changes `current`, timers, environment or database records.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const fprWorkerFiles = ["scripts/rating_worker.mjs", "src/services/community-rating/recalculation.ts",
  "src/services/community-rating/facts.ts", "src/services/community-rating/fpr.ts", "src/components/tournaments/fpr6x25.ts"];
export const fprWorkerReplacements = [
  { file: fprWorkerFiles[0], before: 'db.collection("tournaments").find(changedFilter, { projection: { tournamentId: 1, exerciseId: 1, id: 1 } }).toArray(),',
    after: 'db.collection("tournaments").find(changedFilter, { projection: { tournamentId: 1, exerciseId: 1, id: 1,\n      tournamentType: 1, "params.fpr6x25.testMode": 1, "params.fpr6x25.communityRating": 1 } }).toArray(),' },
  { file: fprWorkerFiles[0], before: '  feed.forEach((row) => ids.add(toStr(row.communityId)));\n',
    after: '  feed.forEach((row) => ids.add(toStr(row.communityId)));\n  tournaments.forEach(row => {\n    const state = row.params?.fpr6x25, binding = state?.communityRating;\n    if (row.tournamentType === "fpr_6x25" && state?.testMode === false && binding?.policy === "community-tournament-v1") {\n      ids.add(toStr(binding.communityId));\n    }\n  });\n' },
  { file: fprWorkerFiles[1], before: '    ...idOrFilter(tournamentIds, ["tournamentId", "id", "exerciseId", "sourceTournamentId"]),\n    archived: { $ne: true },',
    after: '    archived: { $ne: true },\n    $or: [\n      idOrFilter(tournamentIds, ["tournamentId", "id", "exerciseId", "sourceTournamentId"]),\n      { tournamentType: "fpr_6x25", "params.fpr6x25.testMode": false,\n        "params.fpr6x25.communityRating.policy": "community-tournament-v1",\n        "params.fpr6x25.communityRating.communityId": normalizedCommunityId,\n        $or: [{ "params.fpr6x25.communityRating.sourceExerciseId": { $in: tournamentIds } }, { tournamentId: { $in: tournamentIds } }] },\n    ],' },
];
export const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const safeFile = (root, relative) => {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === "." || p === "..")) throw new Error("Unsafe manifest path");
  const file = path.join(root, relative), realRoot = fs.realpathSync(root);
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.join(realRoot, relative)) throw new Error(`Non-regular manifest file: ${relative}`);
  return file;
};
const checkedBytes = (root, relative, expected) => {
  const bytes = fs.readFileSync(safeFile(root, relative));
  if (!/^[a-f0-9]{64}$/.test(expected || "") || sha256(bytes) !== expected) throw new Error(`Hash mismatch: ${relative}`);
  return bytes;
};

export function buildFprRatingWorkerOverlay({ baselineRoot, sourceRoot, outputRoot, contract }) {
  if (fs.existsSync(outputRoot)) throw new Error("Output already exists");
  if (!/^[a-f0-9]{40}$/.test(contract.sourceCommit || "")) throw new Error("Source commit required");
  const baselineBytes = checkedBytes(baselineRoot, "release-manifest.json", contract.baselineManifestSha256);
  const manifest = JSON.parse(baselineBytes);
  if (manifest.dirtyWorktree !== false || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Clean baseline manifest required");
  const output = new Map();
  for (const entry of manifest.files) {
    if (output.has(entry.path) || entry.path === "release-manifest.json") throw new Error("Duplicate/reserved manifest path");
    output.set(entry.path, checkedBytes(baselineRoot, entry.path, entry.sha256));
  }
  if (Object.keys(contract.sourceFiles || {}).sort().join("\n") !== [...fprWorkerFiles].sort().join("\n")) throw new Error("Exact FPR source allowlist required");
  const source = new Map(fprWorkerFiles.map(file => [file, checkedBytes(sourceRoot, file, contract.sourceFiles[file])]));
  for (const file of fprWorkerFiles.slice(0, 3)) {
    if (!output.has(file) || sha256(output.get(file)) !== contract.baselineFiles?.[file]) throw new Error(`Preimage mismatch: ${file}`);
  }
  for (const file of fprWorkerFiles.slice(3)) if (output.has(file)) throw new Error("Existing FPR overlay requires a new reviewed contract");
  for (const { file, before, after } of fprWorkerReplacements) {
    const previous = output.get(file).toString("utf8"), owningSource = source.get(file).toString("utf8");
    if (previous.split(before).length !== 2 || owningSource.split(after).length !== 2) throw new Error(`Non-unique FPR patch anchor: ${file}`);
    output.set(file, Buffer.from(previous.replace(before, after)));
  }
  for (const file of fprWorkerFiles.slice(2)) output.set(file, source.get(file));
  const files = [...output].map(([file, bytes]) => ({ path: file, sha256: sha256(bytes) }));
  const changed = files.filter(entry => manifest.files.find(old => old.path === entry.path)?.sha256 !== entry.sha256).map(entry => entry.path).sort();
  if (changed.join("\n") !== [...fprWorkerFiles].sort().join("\n")) throw new Error("Unexpected overlay delta");
  fs.mkdirSync(outputRoot, { recursive: false, mode: 0o755 });
  fs.chmodSync(outputRoot, 0o755);
  for (const [file, bytes] of output) {
    const target = path.join(outputRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let directory = outputRoot;
    for (const segment of file.split("/").slice(0, -1)) {
      directory = path.join(directory, segment); fs.chmodSync(directory, 0o755);
    }
    const mode = fs.existsSync(path.join(baselineRoot, file)) ? fs.statSync(safeFile(baselineRoot, file)).mode & 0o777 : 0o644;
    fs.writeFileSync(target, bytes, { mode });
    fs.chmodSync(target, mode);
  }
  const next = { ...manifest, releaseId: path.basename(outputRoot), generatedAt: new Date().toISOString(), gitSha: contract.sourceCommit,
    dirtyWorktree: false, composition: { kind: "fpr-community-overlay-v1", baselineGitSha: manifest.gitSha,
      baselineManifestSha256: contract.baselineManifestSha256, sourceFiles: contract.sourceFiles, changedFiles: changed }, files };
  fs.writeFileSync(path.join(outputRoot, "release-manifest.json"), JSON.stringify(next, null, 2) + "\n");
  fs.chmodSync(path.join(outputRoot, "release-manifest.json"), 0o644);
  return { ok: true, files: files.length, changedFiles: changed, manifestSha256: sha256(fs.readFileSync(path.join(outputRoot, "release-manifest.json"))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [baselineRoot, sourceRoot, outputRoot, contractPath] = process.argv.slice(2);
  if (!contractPath) throw new Error("Usage: node build_fpr_rating_worker_overlay.mjs BASE SOURCE NEW_OUTPUT CONTRACT_JSON");
  console.log(JSON.stringify(buildFprRatingWorkerOverlay({ baselineRoot, sourceRoot, outputRoot, contract: JSON.parse(fs.readFileSync(contractPath, "utf8")) })));
}
