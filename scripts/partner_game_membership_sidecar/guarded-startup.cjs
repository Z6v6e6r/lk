"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createGuardedPartnerSettings, validatePartnerGuardFlows } = require("./settings-guarded.cjs");
const { openPartnerRawAudit } = require("./raw-audit.cjs");
const { parsePartnerRawJson } = require("./raw-request-guard.cjs");

const fail = () => { throw new Error("PARTNER_GUARDED_STARTUP_REFUSED"); };
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const STARTUP_ANCHOR_PATH = "/etc/padlhub/partner-game-membership/approved-startup.json";
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const stableFields = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "nlink", "uid"];
// DEFAULT_OFF_UNBOUND and BOUND_DEFAULT_OFF are non-activatable. BOUND_ACTIVE is the only
// mode that may serve traffic, and it is reachable only through a root-owned anchor that
// explicitly authorizes activation for a bounded set of clients and game sets.
const STARTUP_MODES = Object.freeze(["DEFAULT_OFF_UNBOUND", "BOUND_DEFAULT_OFF", "BOUND_ACTIVE"]);
const ACTIVE_CONTRACT_REVISION = "padlhub-viva-technical-booking-v1";
const ACTIVE_PROVIDER_MODE = "viva";
const ANCHOR_FIELDS = Object.freeze(["formatVersion", "mode", "expectedHost", "expectedAudience",
  "candidateFlowSha256", "releaseDirectory", "packetManifestSha256", "approvedCommit", "approvedTree"]);
const ANCHOR_ACTIVE_FIELDS = Object.freeze([...ANCHOR_FIELDS, "activationAuthorized", "authorizedClients"]);
const MAX_AUTHORIZED_CLIENTS = 16;
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const GAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const exactKeys = (value, keys) => {
  if (!value || Array.isArray(value) || typeof value !== "object"
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail();
};
const within = (parent, file) => {
  const relative = path.relative(parent, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function rootAncestors(file, io) {
  const result = [];
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const stat = io.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) fail();
    result.push([directory, stat]);
    if (path.dirname(directory) === directory) return result;
  }
}

function readPinnedFile(file, maxBytes, { io = fs, rootOwned = false, snapshot = [] } = {}) {
  if (!path.isAbsolute(file) || io.realpathSync(file) !== file) fail();
  const ancestors = rootOwned ? rootAncestors(file, io) : [];
  const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = io.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size === 0 || before.size > maxBytes
      || (before.mode & 0o022) !== 0 || !(rootOwned ? before.uid === 0 : [0, process.getuid()].includes(before.uid))) fail();
    const bytes = Buffer.alloc(before.size);
    if (io.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) fail();
    const after = io.fstatSync(fd);
    const named = io.lstatSync(file);
    for (const field of stableFields) {
      if (before[field] !== after[field] || before[field] !== named[field]) fail();
    }
    for (const [directory, stat] of ancestors) {
      const current = io.lstatSync(directory);
      for (const field of stableFields) if (stat[field] !== current[field]) fail();
    }
    snapshot.push([file, before], ...ancestors);
    return bytes;
  } finally { io.closeSync(fd); }
}

function readStartupAnchor(io, snapshot) {
  // Missing is distinct from unreadable/malformed. No env/CLI/packet path override.
  try { if ((io.lstatSync(STARTUP_ANCHOR_PATH).mode & 0o111) !== 0) fail(); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return parsePartnerRawJson(readPinnedFile(STARTUP_ANCHOR_PATH, 4096, { io, rootOwned: true, snapshot }));
}

function validateBoundRelease({ anchor, sidecarDirectory, candidateBytes, env, io, snapshot, mode }) {
  const active = mode === "BOUND_ACTIVE";
  exactKeys(anchor, active ? ANCHOR_ACTIVE_FIELDS : ANCHOR_FIELDS);
  const root = path.dirname(sidecarDirectory);
  if (anchor.formatVersion !== 1 || anchor.mode !== mode
    || anchor.releaseDirectory !== root || root === path.parse(root).root
    || within(root, STARTUP_ANCHOR_PATH)
    || typeof anchor.expectedHost !== "string" || anchor.expectedHost.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(anchor.expectedHost)
    || anchor.expectedHost === "unbound.invalid"
    || typeof anchor.expectedAudience !== "string" || !/^[a-z0-9][a-z0-9._:-]{2,127}$/.test(anchor.expectedAudience)
    || env.LK_PARTNER_GAME_API_AUDIENCE !== anchor.expectedAudience
    || !HASH.test(anchor.candidateFlowSha256) || digest(candidateBytes) !== anchor.candidateFlowSha256
    || !HASH.test(anchor.packetManifestSha256) || !COMMIT.test(anchor.approvedCommit) || !COMMIT.test(anchor.approvedTree)) fail();
  if (active) {
    // Activation is bounded to the clients the anchor names and to the game set each of them
    // is declared for. The running keyring must match that declaration exactly: every enabled
    // client is declared, nothing is declared that is not enabled, and no client may hold a
    // game outside its own declared set. Enabling a client therefore always requires a fresh
    // root-owned anchor. The packet manifest never authorizes activation.
    if (anchor.activationAuthorized !== true) fail();
    const declared = anchor.authorizedClients;
    if (!declared || Array.isArray(declared) || typeof declared !== "object") fail();
    const declaredIds = Object.keys(declared);
    if (declaredIds.length < 1 || declaredIds.length > MAX_AUTHORIZED_CLIENTS) fail();
    for (const clientId of declaredIds) {
      const gameIds = declared[clientId];
      if (!CLIENT_ID_PATTERN.test(clientId)
        || !Array.isArray(gameIds) || gameIds.length < 1 || gameIds.length > 8
        || new Set(gameIds).size !== gameIds.length
        || gameIds.some(id => typeof id !== "string" || !GAME_ID_PATTERN.test(id))) fail();
    }
    let keyring;
    try { keyring = parsePartnerRawJson(Buffer.from(String(env.LK_PARTNER_GAME_API_KEYRING_JSON || ""), "utf8")); }
    catch { fail(); }
    if (!keyring || Array.isArray(keyring) || typeof keyring !== "object") fail();
    const enabled = Object.entries(keyring).filter(([, credential]) => credential && credential.enabled === true);
    if (enabled.length !== declaredIds.length
      || enabled.some(([clientId]) => !Object.hasOwn(declared, clientId))) fail();
    for (const [clientId, credential] of enabled) {
      const games = credential.games && typeof credential.games === "object" && !Array.isArray(credential.games)
        ? Object.keys(credential.games)
        : [];
      if (games.length < 1 || games.some(gameId => !declared[clientId].includes(gameId))) fail();
    }
  }
  const manifestBytes = readPinnedFile(path.join(root, "packet.manifest.json"), 16384, { io, rootOwned: true, snapshot });
  if (digest(manifestBytes) !== anchor.packetManifestSha256) fail();
  const manifest = parsePartnerRawJson(manifestBytes);
  exactKeys(manifest, ["formatVersion", "deploymentId", "state", "repository", "productionControlsSha256",
    "customNodeReleaseSha256", "files", "aggregateSha256", "deployAuthorized", "activationAuthorized"]);
  exactKeys(manifest.repository, ["commit", "tree", "branch"]);
  if (manifest.formatVersion !== 1 || manifest.deploymentId !== "partner-game-membership-api-v02"
    || manifest.state !== "COMPLETE_PRIVATE_PACKET" || manifest.deployAuthorized !== false || manifest.activationAuthorized !== false
    || manifest.repository.commit !== anchor.approvedCommit || manifest.repository.tree !== anchor.approvedTree
    || typeof manifest.repository.branch !== "string" || !manifest.repository.branch
    || !HASH.test(manifest.productionControlsSha256) || !HASH.test(manifest.customNodeReleaseSha256)
    || !Array.isArray(manifest.files) || manifest.files.length > 128
    || digest(Buffer.from(JSON.stringify(manifest.files))) !== manifest.aggregateSha256) fail();
  const required = new Set(["candidate.flow.json", "runtime/package.json", "runtime/package-lock.json",
    ...["settings.cjs", "settings-runtime.cjs", "settings-guarded.cjs", "guarded-startup.cjs", "raw-request-guard.cjs",
      "raw-audit.cjs", "guarded-runtime-policy.json", "partner-game-membership-sidecar.service"].map(name => `sidecar/${name}`),
    ...["package.json", "package-lock.json", "partner-game-membership-core.mjs", "partner-game-membership-mongo.mjs",
      "partner-game-membership-viva.mjs", "partner-game-membership-node.cjs", "partner-game-membership-ingress.cjs", "partner-game-membership-node.html"]
      .map(name => `runtime/partner-package/${name}`)]);
  const seen = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    exactKeys(file, ["relativePath", "sha256", "size", "mode"]);
    if (typeof file.relativePath !== "string" || !/^[a-zA-Z0-9._/-]+$/.test(file.relativePath)
      || file.relativePath !== path.posix.normalize(file.relativePath) || path.posix.isAbsolute(file.relativePath)
      || file.relativePath.split("/").some(part => part === ".." || part === "." || !part)
      || file.relativePath === "packet.manifest.json" || seen.has(file.relativePath)
      || !HASH.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 2 * 1024 * 1024
      || file.mode !== "0600" || (totalBytes += file.size) > 16 * 1024 * 1024) fail();
    const bytes = readPinnedFile(path.join(root, file.relativePath), file.size, { io, rootOwned: true, snapshot });
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) fail();
    if (file.relativePath === "candidate.flow.json" && !bytes.equals(candidateBytes)) fail();
    seen.add(file.relativePath); required.delete(file.relativePath);
  }
  if (required.size) fail();
  // npm's reviewed file:./partner-package layout must load exactly the source
  // closure above, not a second installed package with the same name/version.
  const installed = path.join(root, "runtime/node_modules/@padlhub/node-red-partner-game-membership-api");
  const installedStat = io.lstatSync(installed);
  if (!installedStat.isSymbolicLink() || installedStat.uid !== 0
    || io.readlinkSync(installed) !== "../../partner-package"
    || io.realpathSync(installed) !== path.join(root, "runtime/partner-package")) fail();
  snapshot.push([installed, installedStat], ...rootAncestors(installed, io));
}

function validateGuardedStartup({ sidecarDirectory, argv, env, io = fs }) {
  try {
    if (io.realpathSync(sidecarDirectory) !== sidecarDirectory || !Array.isArray(argv) || argv.length !== 5
      || argv[0] !== "--userDir" || argv[2] !== "--settings") fail();
    const settingsPath = path.join(sidecarDirectory, "settings-runtime.cjs");
    const candidatePath = path.join(sidecarDirectory, "../candidate.flow.json");
    // The installed /current alias can point at a canonical release directory.
    // Resolve the CLI targets to that release; storage below never rereads them.
    if (!path.isAbsolute(argv[3]) || !path.isAbsolute(argv[4])
      || io.realpathSync(argv[3]) !== settingsPath || io.realpathSync(argv[4]) !== candidatePath
      || io.realpathSync(settingsPath) !== settingsPath) fail();
    const userDir = argv[1];
    const state = io.lstatSync(userDir);
    if (!path.isAbsolute(userDir) || io.realpathSync(userDir) !== userDir || !state.isDirectory()
      || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) fail();
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_RED_ENABLE_SAFE_MODE", "NODE_RED_ENABLE_PROJECTS"]) {
      if (env[name] !== undefined && env[name] !== "") fail();
    }
    const mode = env.LK_PARTNER_GAME_API_STARTUP_MODE === undefined ? "DEFAULT_OFF_UNBOUND" : env.LK_PARTNER_GAME_API_STARTUP_MODE;
    if (!STARTUP_MODES.includes(mode)) fail();
    const active = mode === "BOUND_ACTIVE";
    if (active) {
      // BOUND_ACTIVE is the only activatable mode and requires every provider gate plus the
      // pinned technical client. Any partial combination is refused.
      if (env.LK_PARTNER_GAME_API_ENABLED !== "true" || env.LK_PARTNER_GAME_API_PROVIDER_MODE !== ACTIVE_PROVIDER_MODE
        || env.LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED !== "true"
        || env.LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION !== ACTIVE_CONTRACT_REVISION
        || env.LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED !== "true"
        || env.LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED !== "true"
        || typeof env.LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID !== "string"
        || !env.LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID.trim()) fail();
    } else if (env.LK_PARTNER_GAME_API_ENABLED !== "false" || env.LK_PARTNER_GAME_API_PROVIDER_MODE !== "disabled"
      || env.LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED !== "false") fail();
    const snapshot = [];
    const anchor = readStartupAnchor(io, snapshot);
    const bound = mode === "BOUND_DEFAULT_OFF" || active;
    if (bound !== (anchor !== null)
      || (bound && (within(userDir, path.dirname(sidecarDirectory)) || within(path.dirname(sidecarDirectory), userDir)
        || within(userDir, STARTUP_ANCHOR_PATH)))) fail();
    const policy = parsePartnerRawJson(readPinnedFile(path.join(sidecarDirectory, "guarded-runtime-policy.json"), 4096, { io, rootOwned: bound, snapshot }));
    if (Object.keys(policy).sort().join(",") !== "candidateFlowSha256,expectedHost,formatVersion,mode"
      || policy.formatVersion !== 1 || policy.mode !== "DEFAULT_OFF_UNBOUND" || policy.expectedHost !== "unbound.invalid"
      || !/^[a-f0-9]{64}$/.test(policy.candidateFlowSha256)) fail();
    const candidateBytes = readPinnedFile(candidatePath, 64 * 1024, { io, rootOwned: bound, snapshot });
    if (digest(candidateBytes) !== policy.candidateFlowSha256) fail();
    validatePartnerGuardFlows(JSON.parse(candidateBytes));
    if (bound) {
      validateBoundRelease({ anchor, sidecarDirectory, candidateBytes, env, io, snapshot, mode });
      for (const [file, stat] of snapshot) {
        const current = io.lstatSync(file);
        for (const field of stableFields) if (stat[field] !== current[field]) fail();
      }
    }
    return { candidateBytes, candidatePath, userDir, expectedHost: bound ? anchor.expectedHost : policy.expectedHost };
  } catch { fail(); }
}

// Node-RED assigns CLI flowFile again AFTER loading settings. Supply the exact
// captured graph through its storage interface, so that assignment cannot cause
// a second mutable pathname read. No editor/deploy/credential-file writes here.
function createPinnedFlowStorage(candidateBytes, baseStorage) {
  const snapshot = Buffer.from(candidateBytes).toString("utf8");
  validatePartnerGuardFlows(JSON.parse(snapshot));
  const denied = async () => { throw new Error("PARTNER_IMMUTABLE_FLOW_WRITE_REFUSED"); };
  return {
    init: (...args) => baseStorage.init(...args),
    getFlows: async () => JSON.parse(snapshot),
    getCredentials: async () => ({}),
    saveFlows: denied,
    saveCredentials: denied,
    getSettings: (...args) => baseStorage.getSettings(...args),
    saveSettings: (...args) => baseStorage.saveSettings(...args),
    getSessions: (...args) => baseStorage.getSessions(...args),
    saveSessions: (...args) => baseStorage.saveSessions(...args),
    getLibraryEntry: denied,
    saveLibraryEntry: denied,
  };
}

function loadGuardedRuntimeSettings(sidecarDirectory) {
  let audit;
  try {
    const input = validateGuardedStartup({ sidecarDirectory, argv: process.argv.slice(2), env: process.env });
    const baseStorage = require(path.join(sidecarDirectory, "../runtime/node_modules/@node-red/runtime/lib/storage/localfilesystem"));
    audit = openPartnerRawAudit({ directory: input.userDir });
    const settings = createGuardedPartnerSettings({ flows: JSON.parse(input.candidateBytes), expectedHost: input.expectedHost, audit: audit.write });
    settings.storageModule = createPinnedFlowStorage(input.candidateBytes, baseStorage);
    settings.flowFile = input.candidatePath;
    settings.userDir = input.userDir;
    settings.editorTheme = { projects: { enabled: false } };
    process.once("exit", () => { try { audit.close(); } catch { /* preserve lock for manual recovery */ } });
    return settings;
  } catch {
    try { audit?.close(); } catch { /* preserve unconfirmed lock */ }
    fail();
  }
}

module.exports = { validateGuardedStartup, createPinnedFlowStorage, loadGuardedRuntimeSettings, STARTUP_ANCHOR_PATH };
