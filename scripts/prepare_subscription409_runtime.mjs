#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build, version as bundlerVersion } from "esbuild";
import { ROOT, RELEASES, sha, settingsCandidate, validateContract } from "./diagnostics/subscription409-contract.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildRuntimeArtifacts(sourceRoot = repository) {
  const options = { absWorkingDir: sourceRoot, bundle: true, platform: "node", target: "node22", format: "cjs",
    write: false, metafile: true, logLevel: "silent" };
  const observer = await build({ ...options, entryPoints: ["scripts/diagnostics/subscription409-bootstrap.mjs"] });
  const installer = await build({ ...options, stdin: { resolveDir: sourceRoot, sourcefile: "installer-entry.mjs", contents:
    'import { main } from "./scripts/subscription409_runtime_147.mjs"; try { main(); } catch(e) { console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(e.message)?e.message:"INSTALLER_FAILED"})); process.exitCode=1; }' } });
  const inputs = [...new Set([...Object.keys(observer.metafile.inputs), ...Object.keys(installer.metafile.inputs)])]
    .filter(f => f !== "installer-entry.mjs");
  const sources = Object.fromEntries(inputs.sort().map(file => [file, sha(fs.readFileSync(path.resolve(sourceRoot, file)))]));
  const external = [...new Set([...Object.values(observer.metafile.outputs), ...Object.values(installer.metafile.outputs)]
    .flatMap(o => o.imports.filter(i => i.external).map(i => i.path)))].sort();
  if (external.some(name => !name.startsWith("node:"))) throw Error("EXTERNAL_DEPENDENCY_INVALID");
  return { bundle: Buffer.from(observer.outputFiles[0].contents), installer: Buffer.from(installer.outputFiles[0].contents),
    sources, external, bundlerVersion, lockSha256: sha(fs.readFileSync(path.join(sourceRoot, "package-lock.json"))) };
}

// Pure packet contents. It never executes supplied settings or contacts production.
export function packetContents({ settings, flow, metadata, release, artifacts, generation = crypto.randomBytes(16).toString("hex"),
  root = ROOT, releases = RELEASES }) {
  if (metadata?.sourceKind !== "live-147" || metadata.sourceHost !== "lk-primary-147"
    || metadata.settingsSha256 !== sha(settings) || metadata.flowSha256 !== sha(flow)) throw Error("SOURCE_ATTESTATION_INVALID");
  const bundleSha256 = sha(artifacts.bundle);
  const after = settingsCandidate(settings, { generation, bundleSha256, release, root, releases });
  const c = validateContract({ formatVersion: 1, kind: "subscription409-runtime", target: "lk-primary-147", generation, release,
    settingsSha256: sha(settings), candidateSha256: sha(after), flowSha256: sha(flow), bundleSha256,
    installerSha256: sha(artifacts.installer), machineSha256: metadata.machineSha256,
    process: metadata.process, hooks: metadata.hooks, preservedFiles: metadata.preservedFiles,
    createdAtMs: metadata.collectedAtMs, coordinatedRestartApproved: metadata.coordinatedRestartApproved === true });
  return { "settings.before.js": settings, "settings.after.js": after, "observer.cjs": artifacts.bundle,
    "installer.cjs": artifacts.installer, "contract.json": Buffer.from(JSON.stringify(c)),
    "source-manifest.json": Buffer.from(JSON.stringify({ release, sources: artifacts.sources, external: artifacts.external,
      bundlerVersion: artifacts.bundlerVersion, lockSha256: artifacts.lockSha256,
      contractSha256: sha(Buffer.from(JSON.stringify(c))), activationPerformed: false })) };
}

async function main() {
  const [snapshot, output] = process.argv.slice(2);
  if (!snapshot || !output || !path.isAbsolute(snapshot) || !path.isAbsolute(output)) throw Error("USAGE_INVALID");
  const repo = fs.realpathSync(repository), parent = fs.realpathSync(path.dirname(output));
  if (output !== path.join(parent, path.basename(output)) || output.startsWith(repo + path.sep)
    || fs.existsSync(output) || fs.lstatSync(parent).isSymbolicLink()) throw Error("PRIVATE_EXTERNAL_WORKSPACE_REQUIRED");
  // Also reject sibling/main worktrees, not just this checkout.
  try {
    const inside = execFileSync("git", ["-C", parent, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (inside === "true") throw Error("PRIVATE_EXTERNAL_WORKSPACE_REQUIRED");
  } catch (e) { if (e.message === "PRIVATE_EXTERNAL_WORKSPACE_REQUIRED") throw e; }
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()) throw Error("CLEAN_SOURCE_REQUIRED");
  const snapshotStat = fs.lstatSync(snapshot);
  if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink() || fs.realpathSync(snapshot) !== snapshot
    || snapshotStat.uid !== process.getuid() || (snapshotStat.mode & 0o777) !== 0o700) throw Error("PRIVATE_SNAPSHOT_REQUIRED");
  const release = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const load = name => {
    const file = path.join(snapshot, name), s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600
      || s.uid !== process.getuid()) throw Error("PRIVATE_SNAPSHOT_REQUIRED");
    return fs.readFileSync(file);
  };
  const contents = packetContents({ settings: load("settings.js"), flow: load("flows.json"),
    metadata: JSON.parse(load("metadata.json")), release, artifacts: await buildRuntimeArtifacts() });
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(contents)) fs.writeFileSync(path.join(output, name), bytes, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ packetPrepared: true, contractSha256: sha(contents["contract.json"]), activationPerformed: false }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(JSON.stringify({ code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : "PACKET_PREPARATION_FAILED" })); process.exitCode = 1; });
}
