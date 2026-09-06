"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createGuardedPartnerSettings, validatePartnerGuardFlows } = require("./settings-guarded.cjs");
const { openPartnerRawAudit } = require("./raw-audit.cjs");

const fail = () => { throw new Error("PARTNER_GUARDED_STARTUP_REFUSED"); };
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function readPinnedFile(file, maxBytes) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size === 0 || before.size > maxBytes
      || (before.mode & 0o022) !== 0 || ![0, process.getuid()].includes(before.uid)) fail();
    const bytes = Buffer.alloc(before.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) fail();
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "nlink", "uid"]) {
      if (before[field] !== after[field] || before[field] !== named[field]) fail();
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function validateGuardedStartup({ sidecarDirectory, argv, env }) {
  try {
    if (fs.realpathSync(sidecarDirectory) !== sidecarDirectory || !Array.isArray(argv) || argv.length !== 5
      || argv[0] !== "--userDir" || argv[2] !== "--settings") fail();
    const settingsPath = path.join(sidecarDirectory, "settings-runtime.cjs");
    const candidatePath = path.join(sidecarDirectory, "../candidate.flow.json");
    // The installed /current alias can point at a canonical release directory.
    // Resolve the CLI targets to that release; storage below never rereads them.
    if (!path.isAbsolute(argv[3]) || !path.isAbsolute(argv[4])
      || fs.realpathSync(argv[3]) !== settingsPath || fs.realpathSync(argv[4]) !== candidatePath
      || fs.realpathSync(settingsPath) !== settingsPath) fail();
    const userDir = argv[1];
    const state = fs.lstatSync(userDir);
    if (!path.isAbsolute(userDir) || fs.realpathSync(userDir) !== userDir || !state.isDirectory()
      || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) fail();
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_RED_ENABLE_SAFE_MODE", "NODE_RED_ENABLE_PROJECTS"]) {
      if (env[name] !== undefined && env[name] !== "") fail();
    }
    // This release is deliberately non-activatable. An approved host/credential
    // activation path must be a separately reviewed source/binding change.
    if (env.LK_PARTNER_GAME_API_ENABLED !== "false" || env.LK_PARTNER_GAME_API_PROVIDER_MODE !== "disabled"
      || env.LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED !== "false") fail();
    const policy = JSON.parse(readPinnedFile(path.join(sidecarDirectory, "guarded-runtime-policy.json"), 4096));
    if (Object.keys(policy).sort().join(",") !== "candidateFlowSha256,expectedHost,formatVersion,mode"
      || policy.formatVersion !== 1 || policy.mode !== "DEFAULT_OFF_UNBOUND" || policy.expectedHost !== "unbound.invalid"
      || !/^[a-f0-9]{64}$/.test(policy.candidateFlowSha256)) fail();
    const candidateBytes = readPinnedFile(candidatePath, 64 * 1024);
    if (digest(candidateBytes) !== policy.candidateFlowSha256) fail();
    validatePartnerGuardFlows(JSON.parse(candidateBytes));
    return { candidateBytes, candidatePath, userDir, expectedHost: policy.expectedHost };
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

module.exports = { validateGuardedStartup, createPinnedFlowStorage, loadGuardedRuntimeSettings };
