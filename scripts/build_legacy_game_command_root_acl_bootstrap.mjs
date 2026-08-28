import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BUILD_IMAGE = "node@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a";
export const BUILD_FLAGS = [
  "-static", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident",
  "-ffile-prefix-map=/src=.", "-Wl,--build-id=none", "-s",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRelative = "scripts/legacy_game_command_root_acl_bootstrap.c";
const binaryName = "legacy-game-command-root-acl-bootstrap";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const safe = String(result.stderr || result.stdout || result.error?.message || "command failed").trim();
    throw new Error(safe || `${command} failed`);
  }
  return String(result.stdout || "").trim();
}

function runBytes(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot });
  if (result.error || result.status !== 0) {
    const safe = String(result.stderr || result.stdout || result.error?.message || "command failed").trim();
    throw new Error(safe || `${command} failed`);
  }
  return Buffer.from(result.stdout);
}

function inspectBuildImage() {
  const imageId = run("docker", ["image", "inspect", BUILD_IMAGE, "--format", "{{.Id}}"]);
  const repoDigests = JSON.parse(run(
    "docker",
    ["image", "inspect", BUILD_IMAGE, "--format", "{{json .RepoDigests}}"],
  ));
  const expectedDigest = BUILD_IMAGE.split("@")[1];
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)
    || !Array.isArray(repoDigests)
    || !repoDigests.some((value) => typeof value === "string" && value.endsWith(`@${expectedDigest}`))) {
    throw new Error("local build image manifest digest mismatch");
  }
  return imageId;
}

function callerIdentity() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("legacy bootstrap build requires a POSIX caller identity");
  }
  return `${process.getuid()}:${process.getgid()}`;
}

function assertStaticAmd64Elf(buffer) {
  if (buffer.length < 64 || buffer.subarray(0, 4).toString("hex") !== "7f454c46"
    || buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(18) !== 62) {
    throw new Error("bootstrap output is not a little-endian ELF64 amd64 executable");
  }
  const programOffset = Number(buffer.readBigUInt64LE(32));
  const programEntrySize = buffer.readUInt16LE(54);
  const programCount = buffer.readUInt16LE(56);
  for (let index = 0; index < programCount; index += 1) {
    const entry = programOffset + index * programEntrySize;
    if (entry + 4 > buffer.length) throw new Error("bootstrap ELF program headers are truncated");
    const type = buffer.readUInt32LE(entry);
    if (type === 2 || type === 3) throw new Error("bootstrap ELF unexpectedly has dynamic or interpreter segments");
  }
}

function parseArgs(argv) {
  const parsed = {};
  const allowed = new Set(["--out", "--environment"]);
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index + 1] === undefined) throw new Error("arguments must be key/value pairs");
    if (!allowed.has(argv[index])) throw new Error(`unknown argument: ${argv[index]}`);
    if (Object.hasOwn(parsed, argv[index])) throw new Error(`duplicate argument: ${argv[index]}`);
    parsed[argv[index]] = argv[index + 1];
  }
  if (!parsed["--out"] || !parsed["--environment"]) {
    throw new Error("Usage: --out /absolute/new/directory --environment production|rehearsal");
  }
  if (!path.isAbsolute(parsed["--out"])) throw new Error("output path must be absolute");
  if (!new Set(["production", "rehearsal"]).has(parsed["--environment"])) throw new Error("invalid environment");
  return { out: path.resolve(parsed["--out"]), environment: parsed["--environment"] };
}

export function buildRootAclBootstrap(argv) {
  const { out, environment } = parseArgs(argv);
  if (fs.existsSync(out)) throw new Error("output directory already exists");
  const stagingPrefix = `${path.basename(out)}.staging-`;
  const orphanedStaging = fs.readdirSync(path.dirname(out)).filter((entry) => entry.startsWith(stagingPrefix));
  if (orphanedStaging.length > 0) throw new Error("review and remove the exact orphaned staging directory before retry");
  const status = run("git", ["status", "--porcelain=v1"]);
  if (environment === "production" && status) throw new Error("production bootstrap build requires a clean checkout");
  const repositoryCommit = run("git", ["rev-parse", "HEAD"]);
  const sourcePath = path.join(repoRoot, sourceRelative);
  const sourceBytes = environment === "production"
    ? runBytes("git", ["show", `${repositoryCommit}:${sourceRelative}`])
    : fs.readFileSync(sourcePath);
  const imageId = inspectBuildImage();

  const staging = fs.mkdtempSync(`${out}.staging-`);
  try {
    fs.chmodSync(staging, 0o700);
    const firstName = binaryName;
    const secondName = `${binaryName}.reproducibility-check`;
    const snapshotName = "source.snapshot.c";
    const compilerSource = environment === "production" ? `/out/${snapshotName}` : `/src/${sourceRelative}`;
    if (environment === "production") {
      fs.writeFileSync(path.join(staging, snapshotName), sourceBytes, { mode: 0o400, flag: "wx" });
    }
    const compilerCommand = [
      "gcc", ...BUILD_FLAGS, "-o", `/out/${firstName}`, compilerSource,
      "&&", "gcc", ...BUILD_FLAGS, "-o", `/out/${secondName}`, compilerSource,
      "&&", "gcc", "--version",
    ].join(" ");
    const dockerArgs = ["run", "--rm", "--user", callerIdentity(),
      "--network", "none", "--platform", "linux/amd64"];
    if (environment === "rehearsal") {
      dockerArgs.push("--mount", `type=bind,src=${repoRoot},dst=/src,readonly`);
    }
    dockerArgs.push(
      "--mount", `type=bind,src=${staging},dst=/out`,
      BUILD_IMAGE, "sh", "-lc", compilerCommand,
    );
    const compilerOutput = run("docker", dockerArgs);
    if (environment === "production") {
      const compiledSource = fs.readFileSync(path.join(staging, snapshotName));
      if (!compiledSource.equals(sourceBytes)) throw new Error("Git source snapshot changed during build");
      fs.rmSync(path.join(staging, snapshotName));
    }
    const binaryPath = path.join(staging, firstName);
    const secondPath = path.join(staging, secondName);
    const binary = fs.readFileSync(binaryPath);
    const second = fs.readFileSync(secondPath);
    if (!binary.equals(second)) throw new Error("bootstrap build is not reproducible");
    fs.rmSync(secondPath);
    assertStaticAmd64Elf(binary);
    fs.chmodSync(binaryPath, 0o500);
    if (environment === "production"
      && (run("git", ["rev-parse", "HEAD"]) !== repositoryCommit || run("git", ["status", "--porcelain=v1"]))) {
      throw new Error("repository identity changed during production build");
    }

    const manifest = {
      schemaVersion: 1,
      artifactKind: "legacy-game-command-root-acl-bootstrap",
      environment,
      repositoryCommit,
      dirtySource: Boolean(status),
      source: {
        path: sourceRelative,
        gitObject: environment === "production",
        sha256: sha256(sourceBytes),
      },
      build: {
        image: BUILD_IMAGE,
        imageId,
        platform: "linux/amd64",
        network: "none",
        compiler: compilerOutput.split("\n")[0],
        flags: BUILD_FLAGS,
        reproducibleDoubleBuild: true,
      },
      artifact: {
        path: binaryName,
        size: binary.length,
        sha256: sha256(binary),
        mode: "0500",
        elfClass: "ELF64",
        machine: "x86_64",
        staticallyLinked: true,
      },
      liveMutationAuthorized: false,
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), `${canonical(manifest)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(staging, out);
    return { out, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(buildRootAclBootstrap(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "bootstrap build failed");
    process.exitCode = 1;
  }
}
