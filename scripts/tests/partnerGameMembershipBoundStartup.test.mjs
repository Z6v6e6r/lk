import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";
import startup from "../partner_game_membership_sidecar/guarded-startup.cjs";
import settingsModule from "../partner_game_membership_sidecar/settings-guarded.cjs";
import { buildPartnerGameMembershipApiSidecarCandidate } from "../patch_partner_game_membership_api_flow.mjs";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => Buffer.from(JSON.stringify(value));
const refused = fn => assert.throws(fn, /^Error: PARTNER_GUARDED_STARTUP_REFUSED$/);

// Synthetic root-custody metadata over owned real temporary bytes. No chown,
// /etc read, root process, real anchor, runtime install, listener or live calls.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-bound-unit-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "release");
  const state = path.join(base, "state");
  const sidecar = path.join(root, "sidecar");
  fs.mkdirSync(sidecar, { recursive: true }); fs.mkdirSync(state, { mode: 0o700 });
  const bytes = json(buildPartnerGameMembershipApiSidecarCandidate().flow);
  const candidate = path.join(root, "candidate.flow.json"); fs.writeFileSync(candidate, bytes);
  const policy = { formatVersion: 1, mode: "DEFAULT_OFF_UNBOUND", expectedHost: "unbound.invalid", candidateFlowSha256: sha(bytes) };
  const sources = { "candidate.flow.json": bytes };
  for (const name of ["settings.cjs", "settings-runtime.cjs", "settings-guarded.cjs", "guarded-startup.cjs",
    "raw-request-guard.cjs", "raw-audit.cjs", "partner-game-membership-sidecar.service"]) {
    sources[`sidecar/${name}`] = fs.readFileSync(path.join(scripts, "partner_game_membership_sidecar", name));
  }
  sources["sidecar/guarded-runtime-policy.json"] = json(policy);
  for (const name of ["package.json", "package-lock.json"]) {
    sources[`runtime/${name}`] = fs.readFileSync(path.join(scripts, "partner_game_membership_runtime", name));
  }
  for (const name of ["package.json", "package-lock.json", "partner-game-membership-core.mjs", "partner-game-membership-mongo.mjs",
    "partner-game-membership-viva.mjs", "partner-game-membership-node.cjs", "partner-game-membership-ingress.cjs", "partner-game-membership-node.html"]) {
    sources[`runtime/partner-package/${name}`] = fs.readFileSync(path.join(scripts, "../node-red/custom-nodes/partner-game-membership-api", name));
  }
  const files = Object.entries(sources).map(([relativePath, content]) => {
    const file = path.join(root, relativePath); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    return { relativePath, sha256: sha(content), size: content.length, mode: "0600" };
  });
  const manifest = { formatVersion: 1, deploymentId: "partner-game-membership-api-v02", state: "COMPLETE_PRIVATE_PACKET",
    repository: { commit: "a".repeat(40), tree: "b".repeat(40), branch: "codex/fixture" },
    productionControlsSha256: "c".repeat(64), customNodeReleaseSha256: "d".repeat(64), files,
    aggregateSha256: sha(json(files)), deployAuthorized: false, activationAuthorized: false };
  const manifestPath = path.join(root, "packet.manifest.json"); fs.writeFileSync(manifestPath, json(manifest));
  const installed = path.join(root, "runtime/node_modules/@padlhub/node-red-partner-game-membership-api");
  fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.symlinkSync("../../partner-package", installed);
  const anchor = { formatVersion: 1, mode: "BOUND_DEFAULT_OFF", expectedHost: "partner.fixture.invalid",
    expectedAudience: "partner-fixture-v2", candidateFlowSha256: sha(bytes), releaseDirectory: root,
    packetManifestSha256: sha(json(manifest)), approvedCommit: manifest.repository.commit, approvedTree: manifest.repository.tree };
  const anchorPath = path.join(base, "fixture-anchor.json"); fs.writeFileSync(anchorPath, json(anchor));
  const realpath = file => file === startup.STARTUP_ANCHOR_PATH ? anchorPath : file;
  const handles = new Map();
  const overrides = new Map();
  let anchorMissing = false;
  let mutateAfterRead;
  const stat = (name, original) => {
    const out = Object.assign(Object.create(Object.getPrototypeOf(original)), original);
    if (name !== state && !name.startsWith(`${state}/`)) {
      out.uid = 0; out.mode = (out.mode & ~0o777) | (out.isDirectory() ? 0o755 : 0o644);
    }
    return Object.assign(out, overrides.get(name) || {});
  };
  const io = { ...fs,
    realpathSync(file) {
      const actual = fs.realpathSync(realpath(file));
      return file === startup.STARTUP_ANCHOR_PATH && actual === anchorPath ? file : actual;
    },
    lstatSync(file) {
      if (file === startup.STARTUP_ANCHOR_PATH && anchorMissing) throw Object.assign(new Error("Synthetic missing anchor"), { code: "ENOENT" });
      // Only the synthetic anchor parents are projected. Never read real /etc.
      if (startup.STARTUP_ANCHOR_PATH.startsWith(`${file}/`) && file !== "/") return stat(file, fs.lstatSync(base));
      return stat(file, fs.lstatSync(realpath(file)));
    },
    openSync(file, flags) { const fd = fs.openSync(realpath(file), flags); handles.set(fd, file); return fd; },
    fstatSync(fd) { return stat(handles.get(fd), fs.fstatSync(fd)); },
    readSync(...args) {
      const count = fs.readSync(...args);
      mutateAfterRead?.(handles.get(args[0]));
      return count;
    },
    closeSync(fd) { handles.delete(fd); return fs.closeSync(fd); },
  };
  const input = { sidecarDirectory: sidecar, argv: ["--userDir", state, "--settings", path.join(sidecar, "settings-runtime.cjs"), candidate], io,
    env: { LK_PARTNER_GAME_API_ENABLED: "false", LK_PARTNER_GAME_API_PROVIDER_MODE: "disabled", LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED: "false",
      LK_PARTNER_GAME_API_STARTUP_MODE: "BOUND_DEFAULT_OFF", LK_PARTNER_GAME_API_AUDIENCE: anchor.expectedAudience } };
  return { root, base, state, sidecar, bytes, candidate, anchor, anchorPath, manifest, manifestPath, installed, input, handles, overrides,
    setMissing: value => { anchorMissing = value; }, afterRead: fn => { mutateAfterRead = fn; },
    writeAnchor: () => fs.writeFileSync(anchorPath, json(anchor)),
    sealManifest: () => { manifest.aggregateSha256 = sha(json(manifest.files)); fs.writeFileSync(manifestPath, json(manifest));
      anchor.packetManifestSha256 = sha(json(manifest)); fs.writeFileSync(anchorPath, json(anchor)); },
  };
}

test("bound startup consumes the external anchor and exact release while preserving immutable default-off settings", async t => {
  const f = fixture(t); const result = startup.validateGuardedStartup(f.input);
  assert.equal(result.expectedHost, f.anchor.expectedHost); assert.deepEqual(result.candidateBytes, f.bytes);
  const settings = settingsModule.createGuardedPartnerSettings({ flows: JSON.parse(result.candidateBytes), expectedHost: result.expectedHost, audit: () => true });
  assert.equal(settings.uiHost, "127.0.0.1"); assert.equal(settings.uiPort, 18894);
  assert.equal(settings.httpAdminRoot, false); assert.equal(settings.disableEditor, true);
  const storage = startup.createPinnedFlowStorage(result.candidateBytes, {});
  fs.writeFileSync(f.candidate, "[]");
  assert.deepEqual(await storage.getFlows(), JSON.parse(f.bytes));
  await assert.rejects(storage.saveFlows(), /PARTNER_IMMUTABLE_FLOW_WRITE_REFUSED/);
  assert.equal(f.handles.size, 0);
});

test("runtime entrypoint wires the bound host and captured storage only after trust validation", async t => {
  const f = fixture(t); const events = []; let auditCloses = 0; let exitCallback;
  const source = fs.readFileSync(path.join(scripts, "partner_game_membership_sidecar/guarded-startup.cjs"), "utf8");
  const loaded = { exports: {} };
  const context = { module: loaded, Buffer,
    process: { argv: ["fixture-node", "fixture-node-red", ...f.input.argv], env: f.input.env, getuid: () => process.getuid(),
      once: (name, callback) => { assert.equal(name, "exit"); exitCallback = callback; } },
    require: name => {
      if (name === "node:fs") return f.input.io;
      if (["node:path", "node:crypto"].includes(name)) return require(name);
      if (name === "./settings-guarded.cjs") return { ...settingsModule, createGuardedPartnerSettings: options => {
        assert.equal(options.expectedHost, f.anchor.expectedHost); events.push("settings"); return settingsModule.createGuardedPartnerSettings(options);
      } };
      if (name === "./raw-request-guard.cjs") return require("../partner_game_membership_sidecar/raw-request-guard.cjs");
      if (name === "./raw-audit.cjs") return { openPartnerRawAudit: ({ directory }) => {
        assert.equal(directory, f.state); events.push("audit"); return { write: () => true, close: () => { auditCloses++; } };
      } };
      assert.equal(name, path.join(f.root, "runtime/node_modules/@node-red/runtime/lib/storage/localfilesystem"));
      events.push("storage"); return {};
    } };
  vm.runInNewContext(source, context);
  const settings = loaded.exports.loadGuardedRuntimeSettings(f.sidecar);
  assert.deepEqual(events, ["storage", "audit", "settings"]);
  assert.equal(settings.userDir, f.state); assert.equal(settings.flowFile, f.candidate);
  assert.equal(JSON.stringify(await settings.storageModule.getFlows()), f.bytes.toString());
  exitCallback(); assert.equal(auditCloses, 1);
  events.length = 0; f.setMissing(true);
  refused(() => loaded.exports.loadGuardedRuntimeSettings(f.sidecar));
  assert.deepEqual(events, [], "failed trust must precede dependency/audit/settings setup");
});

for (const mode of [undefined, "", "DEFAULT_OFF_UNBOUND", "ACTIVE", "BOUND_ACTIVE", "BOUND_DEFAULT_OFF "]) {
  test(`bound anchor cannot downgrade or change startup mode ${String(mode)}`, t => {
    const f = fixture(t); f.input.env.LK_PARTNER_GAME_API_STARTUP_MODE = mode;
    refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
  });
}
test("required anchor cannot fall back or use an env/CLI/packet substitute", t => {
  const f = fixture(t); f.setMissing(true);
  f.input.env.LK_PARTNER_GAME_API_STARTUP_ANCHOR_PATH = f.anchorPath;
  fs.copyFileSync(f.anchorPath, path.join(f.sidecar, "approved-startup.json"));
  refused(() => startup.validateGuardedStartup(f.input));
  f.input.argv.push("--startup-anchor", f.anchorPath); refused(() => startup.validateGuardedStartup(f.input));
});
for (const field of ["expectedAudience", "candidateFlowSha256", "approvedCommit", "approvedTree", "packetManifestSha256", "releaseDirectory"]) {
  test(`bound startup rejects missing/mismatching ${field}`, t => {
    const f = fixture(t); const original = f.anchor[field];
    delete f.anchor[field]; f.writeAnchor(); refused(() => startup.validateGuardedStartup(f.input));
    f.anchor[field] = field.endsWith("Sha256") ? "e".repeat(64) : field.startsWith("approved") ? "e".repeat(40) : `${original}-other`;
    f.writeAnchor(); refused(() => startup.validateGuardedStartup(f.input));
  });
}
for (const host of ["unbound.invalid", "*.fixture.invalid", "PARTNER.fixture.invalid", "partner.fixture.invalid.",
  "partner.fixture.invalid:443", "https://partner.fixture.invalid", "127.0.0.1", "[::1]", "localhost", "a_1.fixture.invalid", "a".repeat(64) + ".invalid", "bad\nhost.invalid"]) {
  test(`bound startup rejects noncanonical host ${JSON.stringify(host)}`, t => {
    const f = fixture(t); f.anchor.expectedHost = host; f.writeAnchor(); refused(() => startup.validateGuardedStartup(f.input));
  });
}
for (const audience of [undefined, "", "ab", "WRONG", "partner fixture", "fixture\n", "a".repeat(129)]) {
  test(`bound startup refuses invalid or absent runtime audience ${JSON.stringify(audience)}`, t => {
    const f = fixture(t); f.input.env.LK_PARTNER_GAME_API_AUDIENCE = audience;
    refused(() => startup.validateGuardedStartup(f.input));
    if (audience !== undefined) { f.anchor.expectedAudience = audience; f.writeAnchor(); refused(() => startup.validateGuardedStartup(f.input)); }
  });
}
for (const field of ["LK_PARTNER_GAME_API_ENABLED", "LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED", "LK_PARTNER_GAME_API_PROVIDER_MODE"]) {
  for (const value of [undefined, "true", "viva", "synthetic"]) test(`bound startup cannot activate ${field}=${String(value)}`, t => {
    const f = fixture(t); f.input.env[field] = value; refused(() => startup.validateGuardedStartup(f.input));
  });
}
for (const mutation of ["malformed", "extra", "duplicate", "invalid-utf8", "mode", "oversized"]) {
  test(`bound anchor refuses ${mutation} with a fixed non-sensitive error`, t => {
    const f = fixture(t);
    const bytes = mutation === "malformed" ? Buffer.from('{"PRIVATE":"broken')
      : mutation === "extra" ? json({ ...f.anchor, secret: "PRIVATE_VALUE" })
        : mutation === "duplicate" ? Buffer.from(JSON.stringify(f.anchor).replace('{', '{"mode":"PRIVATE_VALUE",'))
          : mutation === "invalid-utf8" ? Buffer.from([0xff]) : mutation === "oversized" ? Buffer.alloc(4097, 32)
            : json({ ...f.anchor, mode: "ACTIVE" });
    fs.writeFileSync(f.anchorPath, bytes); refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
  });
}
for (const kind of ["permission-error", "short-read", "read-error", "fifo", "directory"]) test(`anchor I/O refusal never falls back: ${kind}`, t => {
  const f = fixture(t); const original = f.input.io;
  if (kind === "permission-error") f.input.io = { ...original, lstatSync: file => {
    if (file === startup.STARTUP_ANCHOR_PATH) throw Object.assign(new Error("PRIVATE_ERROR"), { code: "EACCES" });
    return original.lstatSync(file);
  } };
  if (kind === "short-read" || kind === "read-error") f.input.io = { ...original, readSync: (...args) => {
    if (kind === "read-error") throw new Error("PRIVATE_ERROR"); return original.readSync(...args) - 1;
  } };
  if (kind === "fifo") f.overrides.set(startup.STARTUP_ANCHOR_PATH, { mode: 0o010644 });
  if (kind === "directory") f.overrides.set(startup.STARTUP_ANCHOR_PATH, { mode: 0o040644 });
  refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
});
for (const target of [startup.STARTUP_ANCHOR_PATH, "/etc/padlhub", "release", "sidecar", "runtime/package-lock.json"]) {
  for (const problem of ["owner", "writable"]) test(`root custody rejects ${target} ${problem}`, t => {
    const f = fixture(t); const name = target.startsWith("/") ? target : target === "release" ? f.root : path.join(f.root, target);
    const stat = f.input.io.lstatSync(name);
    f.overrides.set(name, problem === "owner" ? { uid: 12345 } : { mode: stat.mode | 0o020 });
    refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
  });
}
for (const property of [{ nlink: 2 }, { mode: 0o100755 }, { mode: 0o100666 }]) test(`anchor rejects unsafe inode ${JSON.stringify(property)}`, t => {
  const f = fixture(t); f.overrides.set(startup.STARTUP_ANCHOR_PATH, property);
  refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
});
for (const target of ["anchor", "candidate", "dependency"]) test(`bound files refuse symlink ${target}`, t => {
  const f = fixture(t); const file = target === "anchor" ? f.anchorPath : target === "candidate" ? f.candidate : path.join(f.root, "runtime/package-lock.json");
  fs.renameSync(file, `${file}.original`); fs.symlinkSync(`${file}.original`, file);
  refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
});
for (const target of [startup.STARTUP_ANCHOR_PATH, "/etc/padlhub", "candidate"]) test(`bound pinned read rejects identity change at ${target}`, t => {
  const f = fixture(t); let changed = false;
  f.afterRead(file => {
    const name = target === "candidate" ? f.candidate : target;
    if (!changed && file === (target === "/etc/padlhub" ? startup.STARTUP_ANCHOR_PATH : name)) {
      changed = true; f.overrides.set(name, { ino: 999999999 });
    }
  });
  refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
});
for (const target of [startup.STARTUP_ANCHOR_PATH, "manifest", "first-source"]) test(`bound final snapshot refuses an earlier input changed during later reads: ${target}`, t => {
  const f = fixture(t); const last = path.join(f.root, f.manifest.files.at(-1).relativePath);
  const name = target === "manifest" ? f.manifestPath : target === "first-source" ? f.candidate : target;
  f.afterRead(file => { if (file === last) f.overrides.set(name, { ino: 999999999 }); });
  refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
});
for (const mutation of ["missing", "substitute", "intermediate-hop", "copy", "owner", "parent-write"]) test(`bound installed custom package refuses ${mutation}`, t => {
  const f = fixture(t);
  if (["missing", "substitute", "intermediate-hop", "copy"].includes(mutation)) fs.unlinkSync(f.installed);
  if (mutation === "substitute") fs.symlinkSync(f.sidecar, f.installed);
  if (mutation === "intermediate-hop") {
    const hop = path.join(f.base, "owned-hop"); fs.symlinkSync(path.join(f.root, "runtime/partner-package"), hop);
    fs.symlinkSync(hop, f.installed);
    assert.equal(fs.realpathSync(f.installed), path.join(f.root, "runtime/partner-package"));
  }
  if (mutation === "copy") fs.mkdirSync(f.installed);
  if (mutation === "owner") f.overrides.set(f.installed, { uid: 12345 });
  if (mutation === "parent-write") {
    const parent = path.dirname(f.installed); f.overrides.set(parent, { mode: f.input.io.lstatSync(parent).mode | 0o020 });
  }
  refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
});
test("a resealed packet with preserved commit/tree cannot approve its own new source bytes", t => {
  const f = fixture(t); const file = f.manifest.files.find(row => row.relativePath === "runtime/partner-package/partner-game-membership-node.cjs");
  const bytes = Buffer.from("modified fixture package"); fs.writeFileSync(path.join(f.root, file.relativePath), bytes);
  file.size = bytes.length; file.sha256 = sha(bytes);
  f.manifest.aggregateSha256 = sha(json(f.manifest.files)); fs.writeFileSync(f.manifestPath, json(f.manifest));
  refused(() => startup.validateGuardedStartup(f.input));
});
for (const mutation of ["source", "missing-file", "manifest-flag", "commit", "tree", "missing-required", "duplicate-file", "traversal", "aggregate", "size"]) {
  test(`bound release rejects ${mutation} even with otherwise approved metadata`, t => {
    const f = fixture(t); const file = f.manifest.files.find(row => row.relativePath === "sidecar/raw-audit.cjs");
    if (mutation === "source") fs.appendFileSync(path.join(f.root, file.relativePath), " ");
    if (mutation === "missing-file") fs.unlinkSync(path.join(f.root, file.relativePath));
    if (mutation === "manifest-flag") f.manifest.activationAuthorized = true;
    if (mutation === "commit") f.manifest.repository.commit = "f".repeat(40);
    if (mutation === "tree") f.manifest.repository.tree = "f".repeat(40);
    if (mutation === "missing-required") f.manifest.files = f.manifest.files.filter(row => row !== file);
    if (mutation === "duplicate-file") f.manifest.files.push(file);
    if (mutation === "traversal") file.relativePath = "../outside.json";
    if (mutation === "size") file.size = 2 * 1024 * 1024 + 1;
    f.sealManifest();
    if (mutation === "aggregate") { f.manifest.aggregateSha256 = "e".repeat(64); fs.writeFileSync(f.manifestPath, json(f.manifest));
      f.anchor.packetManifestSha256 = sha(json(f.manifest)); f.writeAnchor(); }
    refused(() => startup.validateGuardedStartup(f.input)); assert.equal(f.handles.size, 0);
  });
}

const ACTIVE_GAME = "pay_adff32ae-3cca-425d-a31a-36942a75c8f7";
const ACTIVE_STATION = "6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1";
const ACTIVE_TECHNICAL_CLIENT = "a46217b4-d1c0-4363-a848-a9b05d8aa648";
const ACTIVE_REVISION = "padlhub-viva-technical-booking-v1";
const canaryKeyring = (games = { [ACTIVE_GAME]: { tenantKey: null, capacity: 4 } }, clientId = "padlhub-canary") => ({
  [clientId]: { enabled: true, scopes: ["members:add", "members:remove", "operations:read"],
    stationIds: [ACTIVE_STATION], games, keys: { "canary-2026-09": "A".repeat(43) } },
});
const SECOND_GAME = "pay_second-game-0000-0000-000000000000";
const secondClientEntry = { enabled: true, scopes: ["members:add", "members:remove", "operations:read"],
  stationIds: [ACTIVE_STATION], games: { [SECOND_GAME]: { tenantKey: null, capacity: 2 } },
  keys: { "partner-2026-09": "B".repeat(43) } };

// BOUND_ACTIVE is the only activatable mode. It stays reachable only through a root-owned
// anchor that names every client it authorizes and the game set each of them may use, and
// every provider gate plus the pinned technical client must be present.
function activeFixture(t, { authorizedClients = { "padlhub-canary": [ACTIVE_GAME] }, keyring = canaryKeyring() } = {}) {
  const f = fixture(t);
  f.anchor.mode = "BOUND_ACTIVE";
  f.anchor.activationAuthorized = true;
  f.anchor.authorizedClients = authorizedClients;
  f.writeAnchor();
  f.input.env = { ...f.input.env,
    LK_PARTNER_GAME_API_ENABLED: "true", LK_PARTNER_GAME_API_PROVIDER_MODE: "viva",
    LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED: "true", LK_PARTNER_GAME_API_STARTUP_MODE: "BOUND_ACTIVE",
    LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION: ACTIVE_REVISION,
    LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED: "true",
    LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED: "true",
    LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID: ACTIVE_TECHNICAL_CLIENT,
    LK_PARTNER_GAME_API_KEYRING_JSON: JSON.stringify(keyring) };
  return f;
}

test("bound active startup admits several declared clients with their own game sets", (t) => {
  const f = activeFixture(t, {
    authorizedClients: { "padlhub-canary": [ACTIVE_GAME], "partner-second": [SECOND_GAME] },
    keyring: { ...canaryKeyring(), "partner-second": secondClientEntry },
  });
  const result = startup.validateGuardedStartup(f.input);
  assert.equal(result.expectedHost, f.anchor.expectedHost);
  assert.equal(f.handles.size, 0);
});

test("bound active startup admits a declared client whose game set is a subset", (t) => {
  const f = activeFixture(t, { authorizedClients: { "padlhub-canary": [ACTIVE_GAME, SECOND_GAME] } });
  startup.validateGuardedStartup(f.input);
  assert.equal(f.handles.size, 0);
});

test("bound active startup admits a fully gated canary release", (t) => {
  const f = activeFixture(t);
  const result = startup.validateGuardedStartup(f.input);
  assert.equal(result.expectedHost, f.anchor.expectedHost);
  assert.deepEqual(result.candidateBytes, f.bytes);
  assert.equal(f.handles.size, 0);
});

test("the guarded activation contract revision matches the Viva provider revision", async () => {
  const viva = await import("../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-viva.mjs");
  assert.equal(viva.PARTNER_VIVA_CONTRACT_REVISION, ACTIVE_REVISION);
});

for (const [name, mutate] of [
  ["enabled=false", (f) => { f.input.env.LK_PARTNER_GAME_API_ENABLED = "false"; }],
  ["provider=disabled", (f) => { f.input.env.LK_PARTNER_GAME_API_PROVIDER_MODE = "disabled"; }],
  ["mutations=false", (f) => { f.input.env.LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED = "false"; }],
  ["wrong contract revision", (f) => { f.input.env.LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION = "other"; }],
  ["idempotency unconfirmed", (f) => { f.input.env.LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED = "false"; }],
  ["on-place unconfirmed", (f) => { f.input.env.LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED = "false"; }],
  ["missing technical client", (f) => { f.input.env.LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID = "  "; }],
  ["activation not authorized", (f) => { f.anchor.activationAuthorized = false; f.writeAnchor(); }],
  ["empty declared game set", (f) => { f.anchor.authorizedClients = { "padlhub-canary": [] }; f.writeAnchor(); }],
  ["declared clients missing", (f) => { delete f.anchor.authorizedClients; f.writeAnchor(); }],
  ["declared clients is an array", (f) => { f.anchor.authorizedClients = ["padlhub-canary"]; f.writeAnchor(); }],
  ["declared client id is invalid", (f) => { f.anchor.authorizedClients = { "Padlhub Canary": [ACTIVE_GAME] }; f.writeAnchor(); }],
  ["declared game id is invalid", (f) => { f.anchor.authorizedClients = { "padlhub-canary": ["bad game"] }; f.writeAnchor(); }],
  ["declared game ids repeat", (f) => { f.anchor.authorizedClients = { "padlhub-canary": [ACTIVE_GAME, ACTIVE_GAME] }; f.writeAnchor(); }],
  ["declared game set is too large", (f) => { f.anchor.authorizedClients = { "padlhub-canary": Array.from({ length: 9 }, (_, i) => `game-${i}`) }; f.writeAnchor(); }],
  ["too many declared clients", (f) => { f.anchor.authorizedClients = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`client-${i}`, [ACTIVE_GAME]])); f.writeAnchor(); }],
  ["a declared client stays disabled", (f) => {
    f.anchor.authorizedClients = { "padlhub-canary": [ACTIVE_GAME], "partner-second": [SECOND_GAME] };
    f.writeAnchor();
    f.input.env.LK_PARTNER_GAME_API_KEYRING_JSON = JSON.stringify({
      ...canaryKeyring(), "partner-second": { ...secondClientEntry, enabled: false },
    });
  }],
  ["declared client has no enabled counterpart", (f) => { f.anchor.authorizedClients = { "padlhub-canary": [ACTIVE_GAME], "partner-second": [SECOND_GAME] }; f.writeAnchor(); }],
  ["selector and anchor mode disagree", (f) => { f.anchor.mode = "BOUND_DEFAULT_OFF"; f.writeAnchor(); }],
  ["keyring enables an undeclared client", (f) => { f.input.env.LK_PARTNER_GAME_API_KEYRING_JSON = JSON.stringify(canaryKeyring({ [ACTIVE_GAME]: { tenantKey: null, capacity: 4 } }, "other-client")); }],
  ["keyring enables an undeclared second client", (f) => { f.input.env.LK_PARTNER_GAME_API_KEYRING_JSON = JSON.stringify({ ...canaryKeyring(), "second-client": secondClientEntry }); }],
  ["keyring game outside the declared set", (f) => { f.input.env.LK_PARTNER_GAME_API_KEYRING_JSON = JSON.stringify(canaryKeyring({ "other-game": { tenantKey: null, capacity: 4 } })); }],
  ["keyring without games", (f) => { f.input.env.LK_PARTNER_GAME_API_KEYRING_JSON = JSON.stringify(canaryKeyring({})); }],
  ["second client uses another client's game", (f) => {
    f.anchor.authorizedClients = { "padlhub-canary": [ACTIVE_GAME], "partner-second": [SECOND_GAME] };
    f.writeAnchor();
    f.input.env.LK_PARTNER_GAME_API_KEYRING_JSON = JSON.stringify({
      ...canaryKeyring(),
      "partner-second": { ...secondClientEntry, games: { [ACTIVE_GAME]: { tenantKey: null, capacity: 2 } } },
    });
  }],
]) {
  test(`bound active startup refuses ${name}`, (t) => {
    const f = activeFixture(t);
    mutate(f);
    refused(() => startup.validateGuardedStartup(f.input));
    assert.equal(f.handles.size, 0);
  });
}
