// Build an immutable FPR personal-level-only release from an independently verified installed
// worker. This never changes `current`, timers, environment or database records.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const fprWorkerFiles = [
  "scripts/rating_worker.mjs",
  "scripts/game_result_rating_worker.mjs",
  "scripts/lib/fprLevelLedger.mjs",
  "scripts/lib/fprLevelIdentity.mjs",
  "src/services/player-rating/fprTournamentRating.ts",
  "src/services/player-rating/fprRatingReplay.ts"
];
export const fprWorkerReplacements = [
  {
    "file": "scripts/rating_worker.mjs",
    "before": "import crypto from \"node:crypto\";",
    "after": "import { readFprLevelActivation, loadFprLevelContext, processFprLevelLedger, processFprProjectionOutbox } from './lib/fprLevelLedger.mjs';\nimport { readFprLevelIdentityHistory } from \"./lib/fprLevelIdentity.mjs\";\nimport crypto from \"node:crypto\";"
  },
  {
    "file": "scripts/game_result_rating_worker.mjs",
    "before": "import crypto from \"node:crypto\";",
    "after": "import { readFprLevelIdentityHistory } from \"./lib/fprLevelIdentity.mjs\";\nimport crypto from \"node:crypto\";"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "async function loadEventsForIdentity(db, identity) {",
    "after": "export async function loadEventsForIdentity(db, identity) {\n  const current = await loadStateForIdentity(db, identity);\n  if (current?.fprLevelFrontier) return (await readFprLevelIdentityHistory(db, current.clientId)).events;"
  },
  {
    "file": "scripts/game_result_rating_worker.mjs",
    "before": "async function loadIdentityEvents(db, identity) {",
    "after": "export async function loadIdentityEvents(db, identity) {\n  const current = await db.collection(PLAYER_RATING_COLLECTIONS.state).findOne(identityQuery(identity));\n  if (current?.fprLevelFrontier) return (await readFprLevelIdentityHistory(db, current.clientId)).events;"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "  const replay = replayPlayerRatingEvents(events);",
    "after": "  if (current?.fprLevelFrontier) Object.assign(mergedIdentity, { playerKey: current.playerKey, clientId: current.clientId, phoneNorm: current.phoneNorm });\n  const replay = replayPlayerRatingEvents(events);"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "    identityAliases: {\n      clientIds:",
    "after": "    identityAliases: {\n      ...(current?.fprLevelFrontier ? current.identityAliases : {}),\n      clientIds:"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "export async function processTournamentLedger(db, { sinceIso, notBeforeIso, nowIso, dryRun }) {",
    "after": "export async function processTournamentLedger(db, { sinceIso, notBeforeIso, nowIso, dryRun, excludedTournamentIds = new Set() }) {"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "    const tournamentId = resolveTournamentId(tournament);",
    "after": "    const tournamentId = resolveTournamentId(tournament);\n    if (tournament.tournamentType === 'fpr_6x25' || excludedTournamentIds.has(tournamentId)) continue;"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "  const rows = await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).find({",
    "after": "  const rows = await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).find({\n    fprProjection: { $ne: true },"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "    const ledger = await processTournamentLedger(db, {\n      sinceIso: mode === \"full\" ? notBeforeIso : overlapStart,\n      notBeforeIso,\n      nowIso: startedAt,\n      dryRun,\n    });",
    "after": "    const fprConfig = readFprLevelActivation();\n    const fprContext = await loadFprLevelContext(db, fprConfig);\n    const ledger = await processTournamentLedger(db, {\n      sinceIso: mode === \"full\" ? notBeforeIso : overlapStart,\n      notBeforeIso,\n      nowIso: startedAt,\n      dryRun,\n      excludedTournamentIds: fprContext.protectedIds,\n    });\n    const fprLedger = await processFprLevelLedger(db, client, { context: fprContext, config: fprConfig, nowIso: startedAt, dryRun });"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "    const vivaProjection = await processProjectionOutbox(db, projectionUrl, startedAt, dryRun);",
    "after": "    const fprVivaProjection = fprConfig.dispatchEnabled\n      ? await processFprProjectionOutbox(db, projectionUrl, startedAt, dryRun) : { enabled: false };\n    const vivaProjection = await processProjectionOutbox(db, projectionUrl, startedAt, dryRun);"
  },
  {
    "file": "scripts/rating_worker.mjs",
    "before": "      ledger,\n",
    "after": "      ledger,\n      fprLedger,\n      fprVivaProjection,\n"
  }
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
  for (const file of fprWorkerFiles.slice(0, 2)) {
    if (!output.has(file) || sha256(output.get(file)) !== contract.baselineFiles?.[file]) throw new Error(`Preimage mismatch: ${file}`);
  }
  for (const file of fprWorkerFiles.slice(2)) if (output.has(file)) throw new Error("Existing FPR overlay requires a new reviewed contract");
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
    dirtyWorktree: false, recoveryPolicy: "forward-compatible-only-after-fpr-ledger-activation", composition: { kind: "fpr-personal-level-overlay-v1", baselineGitSha: manifest.gitSha,
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
