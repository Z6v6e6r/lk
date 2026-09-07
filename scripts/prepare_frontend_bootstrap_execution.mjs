#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new Error(message); };
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const configuredRepository = process.env.LK_FRONTEND_REPOSITORY;
if (configuredRepository && !path.isAbsolute(configuredRepository)) {
  throw new Error("LK_FRONTEND_REPOSITORY must be absolute");
}
const REPOSITORY = configuredRepository
  ? fs.realpathSync(configuredRepository) : path.resolve(SCRIPT_DIRECTORY, "..");
const files = Object.freeze([
  "bundle.js", "games.js", "tournaments.js", "tournament-signup.js", "group-schedule.js",
  "padel-day-schedule.js", "tournament-subscription.js", "tournament-subscription-referral.js",
  "onboarding.js", "levels-info.js", "communities.js", "release.json",
  "fonts/rf-dewi-ultrabold.woff2", "fonts/rf-dewi-expanded-ultrabold-italic.woff2",
  "fonts/SourceCodePro-Medium.woff2", "fonts/SourceCodePro-Regular.woff2",
]);
const GUARD_IMAGE = "node@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a";
const GUARD_FLAGS = Object.freeze([
  "-static", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident",
  "-ffile-prefix-map=/src=.", "-Wl,--build-id=none", "-s",
]);
const EXECUTION_SOURCES = Object.freeze([
  "scripts/frontend_bootstrap_guard.c",
  "scripts/frontend_bootstrap_exec_launcher.c",
  "scripts/frontend_bootstrap_runtime.mjs",
  "scripts/prepare_frontend_bootstrap_execution.mjs",
  "scripts/audit_frontend_bootstrap_host.mjs",
]);
const git = (args, encoding = "utf8") => execFileSync("git", [
  "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args,
], { cwd: REPOSITORY, encoding, env: {
  PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
} });

const regularBytes = (target) => {
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_CLOEXEC
      | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) {
      fail(`Execution input must be a regular unaliased file: ${target}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || after.nlink !== 1 || bytes.length !== after.size) {
      fail(`Execution input changed while reading: ${target}`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};
const createPrivateDirectory = (target, mode = 0o700) => {
  fs.mkdirSync(target, { recursive: false, mode });
  fs.chmodSync(target, mode);
};
const write = (target, bytes, mode) => {
  fs.writeFileSync(target, bytes, { flag: "wx", mode });
  fs.chmodSync(target, mode);
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} schema mismatch`);
  }
};
const safeRootOwnedRegular = (value) => value.uid === 0 && value.gid === 0
  && value.nlink === 1 && (value.mode & 0o022) === 0;
const safeRootOwnedDirectory = (value) => value.uid === 0 && value.gid === 0
  && (value.mode & 0o022) === 0;
const committedRepository = (production) => {
  if (!production) return { repository: { commit: null, sources: [] }, committedSources: new Map() };
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) {
    fail("Production execution build refuses Node preload environment");
  }
  const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "LK_FRONTEND_REPOSITORY",
    "LK_FRONTEND_BUILDER_COMMIT", "LK_FRONTEND_BUILDER_SHA256", "LK_FRONTEND_NODE_PATH",
    "LK_FRONTEND_NODE_SHA256"]);
  if (Object.keys(process.env).some((name) => !allowedEnvironment.has(name))) {
    fail("Production execution build requires an exact clean environment");
  }
  const expectedCommit = process.env.LK_FRONTEND_BUILDER_COMMIT;
  const expectedBuilderSha256 = process.env.LK_FRONTEND_BUILDER_SHA256;
  const expectedNodePath = process.env.LK_FRONTEND_NODE_PATH;
  const expectedNodeSha256 = process.env.LK_FRONTEND_NODE_SHA256;
  if (!/^[a-f0-9]{40}$/.test(String(expectedCommit || ""))
    || !/^[a-f0-9]{64}$/.test(String(expectedBuilderSha256 || ""))
    || !path.isAbsolute(String(expectedNodePath || ""))
    || !/^[a-f0-9]{64}$/.test(String(expectedNodeSha256 || ""))) {
    fail("Production execution build requires frozen builder and Node identity");
  }
  const selfBytes = regularBytes(fileURLToPath(import.meta.url));
  const nodeBytes = regularBytes(expectedNodePath);
  if (sha256(selfBytes) !== expectedBuilderSha256
    || fs.realpathSync(process.execPath) !== fs.realpathSync(expectedNodePath)
    || sha256(nodeBytes) !== expectedNodeSha256) {
    fail("Production execution builder or Node identity mismatch");
  }
  if (git(["status", "--porcelain=v1"]).trim()) fail("Production execution build requires a clean checkout");
  const commit = git(["rev-parse", "HEAD"]).trim();
  if (commit !== expectedCommit) fail("Production execution commit drift");
  const committedBuilder = Buffer.from(git(["show",
    `${expectedCommit}:scripts/prepare_frontend_bootstrap_execution.mjs`], null));
  if (!selfBytes.equals(committedBuilder)) fail("Executed builder is not the frozen committed source");
  const committedSources = new Map();
  for (const relativePath of EXECUTION_SOURCES) {
    const bytes = Buffer.from(git(["show", `${commit}:${relativePath}`], null));
    if (!regularBytes(path.join(REPOSITORY, relativePath)).equals(bytes)) {
      fail(`Production execution source differs from Git: ${relativePath}`);
    }
    committedSources.set(relativePath, bytes);
  }
  return { committedSources, repository: { commit, sources: EXECUTION_SOURCES.map((relativePath) => ({
    path: relativePath, sha256: sha256(committedSources.get(relativePath)),
  })) } };
};

const STATIC_MARKER = "    location ^~ /lk/ {\n        alias /var/www/html/lk/;";
const BEGIN = "    # BEGIN LK isolated frontend static v1";
const END = "    # END LK isolated frontend static v1";
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nginxBlocks = (source) => {
  const blocks = new Map();
  const stack = [];
  let quote = null;
  let comment = false;
  let inToken = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (comment) { if (character === "\n") comment = false; continue; }
    if (character === "\\") { inToken = true; index += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (!inToken && (character === "\"" || character === "'")) {
      quote = character; inToken = true; continue;
    }
    if (character === "#" && !inToken) { comment = true; continue; }
    if (/\s/.test(character) || character === ";") { inToken = false; continue; }
    if (inToken) continue;
    if (character === "{") { blocks.set(index, { parent: stack.at(-1), end: null }); stack.push(index); }
    if (character === "}") {
      if (!stack.length) fail("Unbalanced nginx block");
      blocks.get(stack.pop()).end = index + 1;
    }
    if (character !== "{" && character !== "}") inToken = true;
  }
  if (stack.length || quote) fail("Unterminated nginx block or string");
  return blocks;
};
const frontendStaticFragment = () => {
  const locations = files.map((name) => {
    const cache = name === "release.json" ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=31536000, immutable";
    const type = name.endsWith(".js") ? "application/javascript"
      : name.endsWith(".json") ? "application/json" : "font/woff2";
    return `    location = /lk/${name} {\n        alias /var/www/html/lk-frontend-current/${name};\n        default_type ${type};\n        open_file_cache off;\n        add_header Access-Control-Allow-Origin "*" always;\n        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;\n        add_header Access-Control-Allow-Headers "Origin, Content-Type, Accept, Authorization, Range" always;\n        add_header Cache-Control "${cache}" always;\n        if ($request_method = OPTIONS) { return 204; }\n        limit_except GET HEAD OPTIONS { deny all; }\n    }`;
  });
  return `${BEGIN}\n${locations.join("\n\n")}\n${END}\n`;
};
const buildFrontendStaticCandidate = (source, expectedSourceSha) => {
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha) || sha256(source) !== expectedSourceSha) {
    fail("Nginx source SHA mismatch");
  }
  if (source.includes(BEGIN) || source.includes(END) || source.includes("/var/www/html/lk-frontend-current")) {
    fail("Isolation already present or unmanaged current-release route");
  }
  const marker = source.indexOf(STATIC_MARKER);
  if (marker < 0 || source.indexOf(STATIC_MARKER, marker + 1) >= 0) {
    fail("Expected one existing legacy static /lk/ location");
  }
  const matches = [...source.matchAll(/^ {4}location = \/lk\/release\.json \{/gm)];
  if (matches.length !== 1) fail("Expected one existing exact release.json location");
  const release = matches[0];
  const blocks = nginxBlocks(source);
  const block = blocks.get(release.index + release[0].length - 1);
  const legacy = blocks.get(marker + STATIC_MARKER.indexOf("{"));
  if (!block || !legacy || release.index >= marker || block.parent === undefined || block.parent !== legacy.parent) {
    fail("Manifest and legacy static location must belong to the same server");
  }
  const end = block.end + (source[block.end] === "\n" ? 1 : 0);
  const original = source.slice(release.index, end);
  if (!original.includes("        root /var/www/html;\n") || !original.includes("        try_files $uri =404;\n")) {
    fail("Unrecognized manifest source location");
  }
  for (const name of files) {
    const pattern = new RegExp(`^\\s*location\\s*=\\s*(?:"|')?/lk/${escapeRegex(name)}(?:"|')?\\s*\\{`, "gm");
    const count = [...source.matchAll(pattern)].length;
    if (count !== (name === "release.json" ? 1 : 0)) {
      fail(`Existing exact route requires separate reconciliation: /lk/${name}`);
    }
  }
  const candidate = source.slice(0, release.index) + frontendStaticFragment() + source.slice(end);
  return { candidate, candidateSha: sha256(candidate) };
};

const assertElf = (bytes) => {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46"
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) {
    fail("Bootstrap executable is not Linux amd64 ELF64");
  }
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  for (let index = 0; index < count; index += 1) {
    const type = bytes.readUInt32LE(offset + index * size);
    if (type === 2 || type === 3) fail("Bootstrap executable must be statically linked");
  }
};
const buildStaticExecutable = ({ sourceBytes, label }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lk-frontend-${label}-`));
  try {
    fs.chmodSync(root, 0o700);
    const sourceName = `${label}.c`;
    fs.writeFileSync(path.join(root, sourceName), sourceBytes, { flag: "wx", mode: 0o400 });
    const caller = `${process.getuid()}:${process.getgid()}`;
    for (const suffix of ["a", "b"]) {
      execFileSync("docker", ["run", "--rm", "--network", "none", "--platform", "linux/amd64",
        "--user", caller, "--mount", `type=bind,src=${root},dst=/out`, GUARD_IMAGE,
        "gcc", ...GUARD_FLAGS, "-o", `/out/${label}-${suffix}`, `/out/${sourceName}`], {
        encoding: "utf8", env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      });
    }
    const first = fs.readFileSync(path.join(root, `${label}-a`));
    const second = fs.readFileSync(path.join(root, `${label}-b`));
    if (!first.equals(second)) fail(`Frontend bootstrap ${label} build is not reproducible`);
    assertElf(first);
    return { bytes: first, sha256: sha256(first), sourceSha256: sha256(sourceBytes),
      image: GUARD_IMAGE, flags: [...GUARD_FLAGS] };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const visitInventory = (root) => {
  const result = [];
  const visit = (directory) => {
    const value = fs.lstatSync(directory);
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid()
      || (value.mode & 0o777) !== 0o700) fail("Execution output directory custody mismatch");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) result.push(path.relative(root, target));
      else fail("Execution output contains a special file");
    }
  };
  visit(root);
  return result.sort();
};
const verifyFrontendBootstrapBundle = ({ bundleRoot, manifestSha256 }) => {
  const manifestPath = path.join(bundleRoot, "manifest.json");
  const manifestBytes = regularBytes(manifestPath);
  if (sha256(manifestBytes) !== manifestSha256) fail("Execution manifest digest mismatch");
  const manifest = JSON.parse(manifestBytes);
  const expected = new Map(manifest.files.map((row) => [row.path, row]));
  const inventory = visitInventory(bundleRoot);
  if (JSON.stringify(inventory) !== JSON.stringify(["manifest.json", ...expected.keys()].sort())) {
    fail("Execution output inventory mismatch");
  }
  for (const [relativePath, row] of expected) {
    const target = path.join(bundleRoot, relativePath);
    const value = fs.lstatSync(target);
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid() || value.nlink !== 1
      || (value.mode & 0o777) !== Number.parseInt(row.mode, 8)) fail("Execution output file custody mismatch");
    const bytes = regularBytes(target);
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256) fail("Execution output file drift");
  }
};

const validateHostSnapshot = (host) => {
  exactKeys(host, ["formatVersion", "kind", "capturedAt", "hostname", "machineIdSha256",
    "config", "htmlRoot", "legacyRoot", "nginx", "systemctl", "node", "curl", "producer",
    "launcherTools", "nginxService", "assetBase", "originResolve", "installed", "installedStats",
    "preservedLegacy", "bootstrapState"], "Frontend bootstrap host snapshot");
  exactKeys(host.producer, ["kind", "sourceSha256", "launcherSha256", "nodeSha256"],
    "Frontend bootstrap host producer");
  exactKeys(host.bootstrapState, ["releasesExists", "currentExists", "globalLeaseExists",
    "stagingEntries", "orphanEntries"], "Frontend bootstrap host state");
  if (host?.formatVersion !== 1 || host?.kind !== "lk-frontend-static-bootstrap-host-snapshot"
    || typeof host.hostname !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host.hostname)
    || host.hostname.includes("..")
    || !/^[a-f0-9]{64}$/.test(String(host.machineIdSha256 || ""))
    || !/^https:\/\//.test(String(host.assetBase || ""))
    || host.bootstrapState?.releasesExists !== false || host.bootstrapState?.currentExists !== false
    || host.bootstrapState?.globalLeaseExists !== false
    || !Array.isArray(host.bootstrapState?.stagingEntries) || host.bootstrapState.stagingEntries.length !== 0
    || !Array.isArray(host.bootstrapState?.orphanEntries) || host.bootstrapState.orphanEntries.length !== 0
    || !Array.isArray(host.preservedLegacy) || host.preservedLegacy.length < 1
    || host.producer?.kind !== "lk-frontend-static-bootstrap-audit"
    || !/^[a-f0-9]{64}$/.test(String(host.producer?.sourceSha256 || ""))
    || !/^[a-f0-9]{64}$/.test(String(host.producer?.launcherSha256 || ""))
    || !/^[a-f0-9]{64}$/.test(String(host.producer?.nodeSha256 || ""))) {
    fail("Frontend bootstrap host snapshot contract mismatch");
  }
  if (!host.launcherTools || typeof host.launcherTools !== "object" || Array.isArray(host.launcherTools)
    || JSON.stringify(Object.keys(host.launcherTools).sort()) !== JSON.stringify([
      "bash", "chmod", "chown", "env", "flock", "readlink", "realpath", "sha256sum", "stat",
    ])) fail("Frontend bootstrap launcher-tool snapshot is invalid");
  for (const item of [host.config, host.nginx, host.systemctl, host.node, host.curl,
    ...Object.values(host.launcherTools)]) {
    exactKeys(item, ["path", "realPath", "stat", "sha256"],
      "Frontend bootstrap executable/config snapshot");
    if (!item || !path.isAbsolute(item.path) || !path.isAbsolute(item.realPath)
      || !/^[a-f0-9]{64}$/.test(String(item.sha256 || "")) || !item.stat) {
      fail("Frontend bootstrap executable/config snapshot is invalid");
    }
  }
  for (const item of [host.htmlRoot, host.legacyRoot]) {
    exactKeys(item, ["path", "realPath", "stat"], "Frontend bootstrap directory snapshot");
    if (!item || !path.isAbsolute(item.path) || !path.isAbsolute(item.realPath) || !item.stat) {
      fail("Frontend bootstrap directory snapshot is invalid");
    }
  }
  if (host.config.path !== "/etc/nginx/sites-enabled/padlhub.su"
    || host.config.realPath !== host.config.path || host.htmlRoot.path !== "/var/www/html"
    || host.htmlRoot.realPath !== host.htmlRoot.path || host.legacyRoot.path !== "/var/www/html/lk"
    || host.legacyRoot.realPath !== host.legacyRoot.path || host.node.path !== "/usr/bin/node"
    || host.node.realPath !== host.node.path || host.curl.path !== "/usr/bin/curl"
    || host.curl.realPath !== host.curl.path || host.systemctl.path !== "/usr/bin/systemctl"
    || host.systemctl.realPath !== host.systemctl.path || host.nginx.path !== "/usr/sbin/nginx"
    || host.nginx.realPath !== host.nginx.path || host.nginxService !== "nginx"
    || host.assetBase !== "https://padlhub.su/lk"
    || host.originResolve !== "padlhub.su:443:127.0.0.1"
    || Object.entries({ bash: "/usr/bin/bash", realpath: "/usr/bin/realpath",
      sha256sum: "/usr/bin/sha256sum", stat: "/usr/bin/stat", readlink: "/usr/bin/readlink",
      chown: "/usr/bin/chown", chmod: "/usr/bin/chmod", flock: "/usr/bin/flock", env: "/usr/bin/env" })
      .some(([name, expected]) => host.launcherTools[name].path !== expected
        || host.launcherTools[name].realPath !== expected)) {
    fail("Frontend bootstrap production topology mismatch");
  }
  for (const value of [host.config.stat, host.htmlRoot.stat, host.legacyRoot.stat,
    host.nginx.stat, host.systemctl.stat, host.node.stat, host.curl.stat,
    ...Object.values(host.launcherTools).map((item) => item.stat)]) {
    exactKeys(value, ["uid", "gid", "mode", "dev", "ino", "nlink"], "Frontend bootstrap stat");
    for (const key of ["uid", "gid", "mode", "dev", "ino", "nlink"]) {
      if (!Number.isSafeInteger(value?.[key]) || value[key] < 0) fail("Frontend bootstrap stat contract is invalid");
    }
  }
  exactKeys(host.installed, ["source", "version", "hashes"], "Frontend bootstrap installed release");
  exactKeys(host.installed.hashes, files, "Frontend bootstrap installed hashes");
  exactKeys(host.installedStats, files, "Frontend bootstrap installed stats");
  if (JSON.stringify(Object.keys(host.installed?.hashes || {}).sort())
    !== JSON.stringify([...files].sort())
    || JSON.stringify(Object.keys(host.installedStats || {}).sort())
      !== JSON.stringify([...files].sort())
    || !/^[a-f0-9]{40}$/.test(String(host.installed?.source || ""))
    || !/^[A-Za-z0-9._-]{1,100}$/.test(String(host.installed?.version || ""))) {
    fail("Frontend bootstrap installed inventory is invalid");
  }
  const preservedNames = host.preservedLegacy.map((row) => row?.name).sort();
  for (const row of host.preservedLegacy) {
    exactKeys(row, ["name", "sha256", "stat"], "Frontend bootstrap preserved legacy row");
  }
  if (JSON.stringify(preservedNames) !== JSON.stringify([
    "ffc-academy-lk-dev.js", "ffc-academy-lk.js", "index.html", "release-dev.json",
  ]) || host.preservedLegacy.some((row) => !/^[a-f0-9]{64}$/.test(String(row?.sha256 || ""))
    || !row.stat)) {
    fail("Frontend bootstrap preserved legacy contract is invalid");
  }
  for (const value of [...Object.values(host.installedStats),
    ...host.preservedLegacy.map((row) => row.stat)]) {
    exactKeys(value, ["uid", "gid", "mode", "dev", "ino", "nlink"],
      "Frontend bootstrap legacy stat");
    for (const key of ["uid", "gid", "mode", "dev", "ino", "nlink"]) {
      if (!Number.isSafeInteger(value?.[key]) || value[key] < 0) {
        fail("Frontend bootstrap legacy stat contract is invalid");
      }
    }
  }
};

export function prepareFrontendBootstrapExecution({ candidateDirectory, hostSnapshot, outputDirectory,
  production = true, guardArtifact = null, launcherArtifact = null }) {
  const { repository, committedSources } = committedRepository(production);
  const sourceBytesFor = (relativePath) => production
    ? committedSources.get(relativePath) : regularBytes(path.join(REPOSITORY, relativePath));
  const candidateInput = path.resolve(candidateDirectory);
  const candidateStat = fs.lstatSync(candidateInput);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()
    || candidateStat.uid !== process.getuid() || (candidateStat.mode & 0o077) !== 0) {
    fail("Offline frontend bootstrap candidate must be user-owned and private");
  }
  const candidate = fs.realpathSync(candidateInput);
  if (production && typeof hostSnapshot !== "string") {
    fail("Production execution requires a private host-snapshot file");
  }
  if (production) {
    const snapshotStat = fs.lstatSync(hostSnapshot);
    if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink() || snapshotStat.nlink !== 1
      || snapshotStat.uid !== process.getuid() || (snapshotStat.mode & 0o077) !== 0) {
      fail("Production host snapshot must be user-owned, private and unaliased");
    }
  }
  const host = typeof hostSnapshot === "string"
    ? JSON.parse(regularBytes(hostSnapshot).toString("utf8"))
    : structuredClone(hostSnapshot);
  validateHostSnapshot(host);
  if (production && ([host.config, host.nginx, host.systemctl, host.node, host.curl,
    ...Object.values(host.launcherTools)]
    .some((item) => !safeRootOwnedRegular(item.stat))
    || [host.htmlRoot, host.legacyRoot].some((item) => !safeRootOwnedDirectory(item.stat))
    || Object.values(host.installedStats).some((value) => !safeRootOwnedRegular(value))
    || host.preservedLegacy.some((row) => !safeRootOwnedRegular(row.stat)))) {
    fail("Frontend bootstrap production custody must remain root-owned");
  }
  const planBytes = regularBytes(path.join(candidate, "bootstrap.json"));
  const plan = JSON.parse(planBytes);
  exactKeys(plan, ["schema", "liveMutationAuthorized", "applied", "legacyDirectoryMutationAllowed",
    "nginx", "installed", "activePath", "legacyPath", "routedPaths", "retainedReleasePath"],
  "Offline frontend bootstrap plan");
  exactKeys(plan.nginx, ["sourceSha", "candidateSha"], "Offline frontend bootstrap nginx plan");
  const sourceBytes = regularBytes(path.join(candidate, "nginx.source.conf"));
  const candidateBytes = regularBytes(path.join(candidate, "nginx.candidate.conf"));
  if (plan?.schema !== "LK_FRONTEND_STATIC_BOOTSTRAP_V1" || plan.liveMutationAuthorized !== false
    || plan.applied !== false || plan.legacyDirectoryMutationAllowed !== false
    || plan.nginx?.sourceSha !== sha256(sourceBytes) || plan.nginx?.candidateSha !== sha256(candidateBytes)
    || plan.nginx.sourceSha !== host.config.sha256 || !equal(plan.installed, host.installed)
    || plan.activePath !== "/var/www/html/lk-frontend-current"
    || plan.legacyPath !== "/var/www/html/lk"
    || !Array.isArray(plan.routedPaths) || plan.routedPaths.length !== files.length) {
    fail("Offline frontend bootstrap plan does not bind the host snapshot");
  }
  const rebuilt = buildFrontendStaticCandidate(sourceBytes.toString("utf8"), plan.nginx.sourceSha);
  if (!candidateBytes.equals(Buffer.from(rebuilt.candidate))
    || plan.nginx.candidateSha !== rebuilt.candidateSha
    || JSON.stringify(plan.routedPaths) !== JSON.stringify(files.map((name) => `/lk/${name}`))) {
    fail("Offline frontend bootstrap candidate is not the deterministic source transform");
  }
  const expectedReleaseDigest = sha256(JSON.stringify(files.map((name) => [name, host.installed.hashes[name]])));
  const expectedReleaseName = `${host.installed.source}-${expectedReleaseDigest.slice(0, 16)}`;
  const releaseName = path.basename(plan.retainedReleasePath || "");
  if (!/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(releaseName)
    || releaseName !== expectedReleaseName
    || path.dirname(plan.retainedReleasePath) !== "/var/www/html/lk-frontend-releases") {
    fail("Offline frontend bootstrap retained release identity is invalid");
  }
  for (const name of files) {
    const target = path.join(candidate, "release", name);
    if (sha256(regularBytes(target)) !== host.installed.hashes[name]) {
      fail(`Offline frontend bootstrap release drift: ${name}`);
    }
  }
  const capturedAt = Date.parse(host.capturedAt);
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt < 0 || Date.now() - capturedAt > 15 * 60_000) {
    fail("Frontend bootstrap host snapshot is stale");
  }

  const parent = path.dirname(path.resolve(outputDirectory));
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid()
    || (parentStat.mode & 0o077) !== 0) fail("Execution output parent must be user-owned and private");
  const output = path.join(fs.realpathSync(parent), path.basename(outputDirectory));
  const relative = path.relative(REPOSITORY, output);
  if (!relative.startsWith(`..${path.sep}`) && relative !== "..") {
    fail("Execution output must remain outside the repository");
  }
  if (production && (guardArtifact || launcherArtifact)) {
    fail("Production execution cannot accept supplied executable artifacts");
  }
  const guardSource = sourceBytesFor("scripts/frontend_bootstrap_guard.c");
  const launcherSource = sourceBytesFor("scripts/frontend_bootstrap_exec_launcher.c");
  const guard = production ? buildStaticExecutable({ sourceBytes: guardSource, label: "guard" })
    : (guardArtifact || { bytes: Buffer.from("fixture guard\n"),
      sha256: sha256("fixture guard\n"), sourceSha256: sha256(guardSource), image: "fixture@sha256", flags: ["-static"] });
  const launcher = production ? buildStaticExecutable({ sourceBytes: launcherSource, label: "launcher" })
    : (launcherArtifact || { bytes: Buffer.from("fixture launcher\n"),
      sha256: sha256("fixture launcher\n"), sourceSha256: sha256(launcherSource), image: "fixture@sha256", flags: ["-static"] });
  if (!guard || !Buffer.isBuffer(guard.bytes) || !/^[a-f0-9]{64}$/.test(String(guard.sha256 || ""))
    || guard.sha256 !== sha256(guard.bytes)
    || guard.sourceSha256 !== sha256(guardSource)
    || typeof guard.image !== "string" || !Array.isArray(guard.flags)) {
    fail("Frontend bootstrap guard artifact is invalid");
  }
  if (!launcher || !Buffer.isBuffer(launcher.bytes) || !/^[a-f0-9]{64}$/.test(String(launcher.sha256 || ""))
    || launcher.sha256 !== sha256(launcher.bytes) || launcher.sourceSha256 !== sha256(launcherSource)
    || typeof launcher.image !== "string" || !Array.isArray(launcher.flags)) {
    fail("Frontend bootstrap launcher artifact is invalid");
  }
  if (production && (host.producer.sourceSha256
      !== sha256(sourceBytesFor("scripts/audit_frontend_bootstrap_host.mjs"))
    || host.producer.launcherSha256 !== launcher.sha256
    || host.producer.nodeSha256 !== host.node.sha256)) {
    fail("Frontend bootstrap audit producer identity mismatch");
  }
  const sources = new Map([
    ["payload/launcher", launcher.bytes],
    ["payload/guard", guard.bytes],
    ["payload/runtime.mjs", sourceBytesFor("scripts/frontend_bootstrap_runtime.mjs")],
    ["payload/bootstrap.json", path.join(candidate, "bootstrap.json")],
    ["payload/nginx.source.conf", path.join(candidate, "nginx.source.conf")],
    ["payload/nginx.candidate.conf", path.join(candidate, "nginx.candidate.conf")],
    ...files.map((name) => [`payload/release/${name}`, path.join(candidate, "release", name)]),
  ]);
  createPrivateDirectory(output);
  createPrivateDirectory(path.join(output, "payload"));
  createPrivateDirectory(path.join(output, "payload/release"));
  createPrivateDirectory(path.join(output, "payload/release/fonts"));
  const rows = [];
  for (const [relativePath, source] of sources) {
    const bytes = Buffer.isBuffer(source) ? source : regularBytes(source);
    const mode = ["payload/launcher", "payload/guard", "payload/runtime.mjs"].includes(relativePath)
      ? 0o500 : 0o400;
    const target = path.join(output, relativePath);
    write(target, bytes, mode);
    rows.push({
      path: relativePath,
      mode: mode.toString(8).padStart(4, "0"),
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const manifest = {
    formatVersion: 1,
    kind: "lk-frontend-static-bootstrap-execution",
    deploymentId: `frontend-static-bootstrap-${host.installed.source.slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    maxSnapshotAgeMs: 15 * 60_000,
    host,
    repository,
    guard: {
      sha256: guard.sha256,
      sourceSha256: guard.sourceSha256,
      image: guard.image,
      flags: guard.flags,
    },
    launcher: {
      sha256: launcher.sha256,
      sourceSha256: launcher.sourceSha256,
      image: launcher.image,
      flags: launcher.flags,
    },
    bootstrap: {
      planSha256: sha256(planBytes),
      nginxSourceSha256: plan.nginx.sourceSha,
      nginxCandidateSha256: plan.nginx.candidateSha,
      releaseName,
    },
    files: rows.sort((left, right) => left.path.localeCompare(right.path)),
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  const manifestSha256 = sha256(manifestBytes);
  write(path.join(output, "manifest.json"), manifestBytes, 0o400);
  verifyFrontendBootstrapBundle({
    bundleRoot: output,
    manifestSha256,
    expectedUid: process.getuid(),
    production: false,
  });
  return {
    output,
    manifestSha256,
    guardSha256: guard.sha256,
    launcherSha256: launcher.sha256,
    runtimeSha256: rows.find((row) => row.path === "payload/runtime.mjs").sha256,
    nodeSha256: host.node.sha256,
    deploymentId: manifest.deploymentId,
    releaseName,
  };
}

export function prepareFrontendBootstrapAuditKit({ outputDirectory, production = true,
  launcherArtifact = null } = {}) {
  const { repository, committedSources } = committedRepository(production);
  const sourceBytesFor = (relativePath) => production
    ? committedSources.get(relativePath) : regularBytes(path.join(REPOSITORY, relativePath));
  if (production && launcherArtifact) fail("Production audit kit cannot accept a supplied launcher");
  const launcherSource = sourceBytesFor("scripts/frontend_bootstrap_exec_launcher.c");
  const launcher = production
    ? buildStaticExecutable({ sourceBytes: launcherSource, label: "launcher" })
    : (launcherArtifact || { bytes: Buffer.from("fixture launcher\n"),
      sha256: sha256("fixture launcher\n"), sourceSha256: sha256(launcherSource),
      image: "fixture@sha256", flags: ["-static"] });
  if (!launcher || !Buffer.isBuffer(launcher.bytes) || launcher.sha256 !== sha256(launcher.bytes)
    || launcher.sourceSha256 !== sha256(launcherSource)) fail("Frontend bootstrap audit launcher is invalid");
  const auditBytes = sourceBytesFor("scripts/audit_frontend_bootstrap_host.mjs");
  const parent = path.dirname(path.resolve(outputDirectory));
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid()
    || (parentStat.mode & 0o077) !== 0) fail("Audit-kit output parent must be user-owned and private");
  const output = path.join(fs.realpathSync(parent), path.basename(outputDirectory));
  const relative = path.relative(REPOSITORY, output);
  if (!relative.startsWith(`..${path.sep}`) && relative !== "..") {
    fail("Audit-kit output must remain outside the repository");
  }
  createPrivateDirectory(output);
  write(path.join(output, "launcher"), launcher.bytes, 0o500);
  write(path.join(output, "audit.mjs"), auditBytes, 0o400);
  const manifest = {
    formatVersion: 1,
    kind: "lk-frontend-static-bootstrap-audit-kit",
    createdAt: new Date().toISOString(),
    repository,
    launcher: { sha256: launcher.sha256, sourceSha256: launcher.sourceSha256,
      image: launcher.image, flags: launcher.flags },
    audit: { sourceSha256: sha256(auditBytes) },
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  write(path.join(output, "manifest.json"), manifestBytes, 0o400);
  for (const [name, mode, digest] of [
    ["launcher", 0o500, launcher.sha256], ["audit.mjs", 0o400, sha256(auditBytes)],
  ]) {
    const target = path.join(output, name);
    const value = fs.lstatSync(target);
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid()
      || value.nlink !== 1 || (value.mode & 0o777) !== mode || sha256(regularBytes(target)) !== digest) {
      fail("Audit-kit output verification failed");
    }
  }
  return { output, manifestSha256: sha256(manifestBytes), launcherSha256: launcher.sha256,
    auditSourceSha256: sha256(auditBytes), repositoryCommit: repository.commit };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--audit-kit") {
      if (process.argv.length !== 4) {
        fail("Usage: prepare_frontend_bootstrap_execution.mjs --audit-kit <new-private-output>");
      }
      process.stdout.write(`${JSON.stringify(prepareFrontendBootstrapAuditKit({
        outputDirectory: process.argv[3],
      }), null, 2)}\n`);
    } else {
      if (process.argv.length !== 5) {
      fail("Usage: prepare_frontend_bootstrap_execution.mjs <offline-candidate> <host-snapshot.json> <new-private-output>");
      }
      process.stdout.write(`${JSON.stringify(prepareFrontendBootstrapExecution({
        candidateDirectory: process.argv[2],
        hostSnapshot: process.argv[3],
        outputDirectory: process.argv[4],
      }), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
