import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BUILD_IMAGE = "node@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a";
export const BUILD_FLAGS = ["-static", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident",
  "-ffile-prefix-map=/src=.", "-Wl,--build-id=none", "-s"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRelative = "scripts/legacy_game_command_h2_identity_audit.c";
const binaryName = "legacy-game-command-h2-identity-audit";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || result.error?.message || command + " failed").trim());
  }
  return String(result.stdout || "").trim();
}
function runBytes(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot });
  if (result.error || result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || result.error?.message || command + " failed").trim());
  }
  return Buffer.from(result.stdout);
}
function assertStaticAmd64Elf(buffer) {
  if (buffer.length < 64 || buffer.subarray(0, 4).toString("hex") !== "7f454c46"
    || buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(18) !== 62) {
    throw new Error("audit output is not a little-endian ELF64 amd64 executable");
  }
  const offset = Number(buffer.readBigUInt64LE(32));
  const size = buffer.readUInt16LE(54);
  const count = buffer.readUInt16LE(56);
  for (let index = 0; index < count; index += 1) {
    const entry = offset + index * size;
    if (entry + 4 > buffer.length) throw new Error("audit ELF program headers are truncated");
    const type = buffer.readUInt32LE(entry);
    if (type === 2 || type === 3) throw new Error("audit ELF unexpectedly has dynamic or interpreter segments");
  }
}
function parseArgs(argv) {
  const parsed = {};
  const allowed = new Set(["--out", "--environment"]);
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index + 1] === undefined) throw new Error("arguments must be key/value pairs");
    if (!allowed.has(argv[index])) throw new Error("unknown argument: " + argv[index]);
    if (Object.hasOwn(parsed, argv[index])) throw new Error("duplicate argument: " + argv[index]);
    parsed[argv[index]] = argv[index + 1];
  }
  if (!parsed["--out"] || !parsed["--environment"]) {
    throw new Error("Usage: --out /absolute/new/directory --environment production|rehearsal");
  }
  if (!path.isAbsolute(parsed["--out"])) throw new Error("output path must be absolute");
  if (!new Set(["production", "rehearsal"]).has(parsed["--environment"])) throw new Error("invalid environment");
  return { out: path.resolve(parsed["--out"]), environment: parsed["--environment"] };
}

export function buildH2IdentityAudit(argv) {
  const { out, environment } = parseArgs(argv);
  if (fs.existsSync(out)) throw new Error("output directory already exists");
  const outputPrefix = path.basename(out) + ".staging-";
  const inputPrefix = path.basename(out) + ".input-";
  if (fs.readdirSync(path.dirname(out)).some((entry) => entry.startsWith(outputPrefix)
    || entry.startsWith(inputPrefix))) {
    throw new Error("review and remove the exact orphaned staging directory before retry");
  }
  const status = run("git", ["status", "--porcelain=v1"]);
  if (environment === "production" && status) throw new Error("production audit build requires a clean checkout");
  const repositoryCommit = run("git", ["rev-parse", "HEAD"]);
  const sourceBytes = environment === "production"
    ? runBytes("git", ["show", repositoryCommit + ":" + sourceRelative])
    : fs.readFileSync(path.join(repoRoot, sourceRelative));
  const imageId = run("docker", ["image", "inspect", BUILD_IMAGE, "--format", "{{.Id}}"]).replace(/^sha256:/, "");
  if (imageId !== BUILD_IMAGE.split("sha256:")[1]) throw new Error("local build image identity mismatch");
  const staging = fs.mkdtempSync(out + ".staging-");
  const input = fs.mkdtempSync(out + ".input-");
  try {
    fs.chmodSync(staging, 0o700);
    fs.chmodSync(input, 0o700);
    const sourceName = "source.snapshot.c";
    const sourcePath = path.join(input, sourceName);
    fs.writeFileSync(sourcePath, sourceBytes, { mode: 0o400, flag: "wx" });
    const first = binaryName;
    const second = binaryName + ".reproducibility-check";
    const command = "gcc " + BUILD_FLAGS.join(" ") + " -o /out/" + first + " /src/" + sourceName
      + " && gcc " + BUILD_FLAGS.join(" ") + " -o /out/" + second + " /src/" + sourceName + " && gcc --version";
    const compiler = run("docker", ["run", "--rm", "--network", "none", "--platform", "linux/amd64",
      "--mount", "type=bind,src=" + input + ",dst=/src,readonly",
      "--mount", "type=bind,src=" + staging + ",dst=/out", BUILD_IMAGE, "sh", "-lc", command]);
    if (!fs.readFileSync(sourcePath).equals(sourceBytes)) throw new Error("source snapshot changed during build");
    fs.rmSync(input, { recursive: true, force: true });
    const binaryPath = path.join(staging, first);
    const binary = fs.readFileSync(binaryPath);
    if (!binary.equals(fs.readFileSync(path.join(staging, second)))) throw new Error("audit build is not reproducible");
    fs.rmSync(path.join(staging, second));
    assertStaticAmd64Elf(binary);
    fs.chmodSync(binaryPath, 0o500);
    if (environment === "production"
      && (run("git", ["rev-parse", "HEAD"]) !== repositoryCommit || run("git", ["status", "--porcelain=v1"]))) {
      throw new Error("repository identity changed during production build");
    }
    const manifest = {
      schemaVersion: 1, artifactKind: "legacy-game-command-h2-identity-audit", environment,
      repositoryCommit, dirtySource: Boolean(status),
      source: { path: sourceRelative, gitObject: environment === "production", sha256: sha256(sourceBytes) },
      build: { image: BUILD_IMAGE, imageId: "sha256:" + imageId, platform: "linux/amd64", network: "none",
        compiler: compiler.split("\n")[0], flags: BUILD_FLAGS, reproducibleDoubleBuild: true },
      artifact: { path: binaryName, size: binary.length, sha256: sha256(binary), mode: "0500",
        elfClass: "ELF64", machine: "x86_64", staticallyLinked: true },
      identityMutationImplemented: false, liveMutationAuthorized: false,
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), canonical(manifest) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(staging, out);
    return { out, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(input, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(buildH2IdentityAudit(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "audit build failed");
    process.exitCode = 1;
  }
}
