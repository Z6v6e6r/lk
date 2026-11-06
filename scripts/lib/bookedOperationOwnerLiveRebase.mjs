import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statements } from './bookedOperationOwnerCompatibility.mjs';

// Step A1 of the quarter CREATE owner route (owner decision 2026-11-06):
// bring the INSTALLED live subscription-booking units up to canonical main
// without losing live-only LK1 behavior. One exact preimage only; never a
// generic upgrader of an unknown flow.
//
// LIVE      = installed func on lk-primary-147 (pinned sha256 below).
// BASE      = canonical sources of the installed owner compatibility build (57648b82).
//             Live contains every BASE statement; live-only LK1 statements are protected.
// CANONICAL = current repository sources (pinned sha256; any source change needs re-review).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODES = 'scripts/nodered_subscription_booking_nodes/';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const LIVE_REBASE_BASE_COMMIT = '57648b82727f7f74ef86637ea8ce9b70416d9e0a';
// Refreshed 2026-11-06 after fpr-cup-start-20261106 (tournament tab only; booking units unchanged).
export const LIVE_REBASE_SOURCE_SHA256 = 'f6fd9f05d29e864000f8b7ca1b41aef4281dbe41821d8114a1011584e3d4e18f';

// [name, node id, [file, base blob, canonical sha256][], live func sha256]
export const LIVE_REBASE_UNITS = Object.freeze([
  ['router', 'lk_subscription_booking_router_20260804', [
    ['fn_subscription_booking_owner_contract_probe.js', '82dd7a1fa6cdd12842e70c89bc2f2b72517bb6ca',
      '0b3701aca84ca526c25704b60f30fd0894e8bfba29673b7274c6bad919d44128'],
    ['fn_subscription_booking_router.js', '6684e368633f27beaa8697687f0083c2779ab4d1',
      '24b8ca287b73752cc39d20413bdd40fc7f65cfb72f54d261e32dbb571eaab443'],
  ], '5e571a859e3ac3363e54d5a21836f9e6199b4dbd14f6c2441e97c356bfdd64ce'],
  ['prepare', 'lk_subscription_booking_prepare_20260804', [
    ['fn_subscription_booking_prepare.js', 'b3c50e97cfff8cc807b2b3670a121c8888bd0d89',
      '954334dcf7f4427c60e72c1d0ab95925b8ba203ec9b2a975738b3bc3f5baf520'],
  ], 'f1cbb94f598635abd767c3494fd0a4d24e8049f3c64a68f2069a731cbd76cf12'],
  ['finalize', 'lk_subscription_booking_finalize_20260804', [
    ['fn_subscription_booking_finalize.js', '4bfe432ac49acc2a60113db9b4779507bb7a2f33',
      '6681987138d2ac6c36f67e702dbe67ca9472a94725097b52461bfd7443e6e63a'],
  ], '2f62d0efd4ed4424b03e43d5f5435ec27fbdebc218be6df8cd99d096b1e7e8ab'],
  ['mongo_error', 'lk_subscription_booking_mongo_error_20260804', [
    ['fn_subscription_booking_mongo_error.js', '5ad8a8515043ad5bbc47712341c50a12e4f31297',
      'e81443265b2eb3393367e3c2a576f74fea943a10c18a045ef1009b295db76d16'],
  ], '1c786def280a91c684dae8a71d56ac903ad1912f059145aa85d1dab0944f3a56'],
]);

// Units intentionally left as installed in this step (sha256 must stay exact).
//  - options: canonical adds a training GET branch that returns on output 3; live
//    options has 2 outputs, so the request would never be answered. The training
//    owner graph is a later step.
//  - managed policy: canonical has no change against the installed build.
export const LIVE_REBASE_UNCHANGED = Object.freeze({
  lk_subscription_booking_options_20260804: '949efce458f5fbd1ba9cb6178f4db75fddc39a9f4affa21ad2268eca58d5b395',
});

// Every overlapping edit is a reviewed decision pinned to the exact LIVE and
// CANONICAL hunk text. Four are insertions at the same anchor. In `profile` live
// moved the shared release/preflight lines (pinned as `base`) and canonical inserted
// before them; only the canonical insertion is relocated. An unknown or drifted
// hunk stops composition.
const LIVE_THEN_MAIN = (live, main) => live + main;
const MAIN_THEN_LIVE = (live, main) => main + live;
export const LIVE_REBASE_RESOLUTIONS = Object.freeze({
  // Live preflight/trial write gates first; canonical CREATE/training restrictions only
  // act on contexts this graph does not produce yet.
  'router|var:emit': { live: '7f184676d7040aece2b77078a364f51809409e9224985dacdded630d1091e7e1', main: 'c45aa7283054be9c61f06f02a2637d963d1e823a24e423e62444952d7d98eade', resolve: LIVE_THEN_MAIN },
  // Same order as the installed compatibility build: live trial gate, then canonical guards.
  'router|var:prepareBookingCreate': { live: '130ac30ff68ffe7b058e1e28fc4232c5a963806057b8fe3d15fdaf3019278b17', main: '929844a8d3d380bdd324416dbc0c1b39f900292c2b4ec9e330c1a0fbc29e7154', resolve: LIVE_THEN_MAIN },
  // JOIN v2 strict receipt first (only ctx.managedJoinV2), then the installed generic receipt check.
  'router|if:ctx.step === "managed_entitlement_reserve"': { live: '2ff3667c973fcb7e8fe8554b38062439f724097aa055574a5adea4ce811e349a', main: '85de123e1fb96edace7c20704e27e446d30a6be80bc86eef7840ea320e17dc2c',
    resolve: MAIN_THEN_LIVE },
  // Canonical inserts SELF leave and JOIN v2 recovery right before release dispatch.
  // Live moved release dispatch behind LK1 ingress replay and product identity into
  // `lk1_profile_continue`; the canonical block goes to the same relative position there,
  // so JOIN v2 cannot skip the installed LK1 identity guards. `profile` keeps its live body.
  'router|if:ctx.step === "profile"': { live: '610a9e6b5c67020b08d6937f09bde3127b7bbac9938e26422e02fdcde737daa5', main: '630f5b9f02814af3ec40510a948cd3d335f8f3e26a94430d5e7e2a8e665508a9', base: 'c162332d20a8254777213c920eeab31578acc58e3cd9531248af2777de5c4d85',
    resolve: live => live,
    relocate: { key: 'if:ctx.step === "lk1_profile_continue"', before: '  if (ctx.action === "release") {\n' } },
  // Disjoint body allowlist keys.
  'prepare|expr:msg._subscriptionBooking = {': { live: 'ee2a52ba91791bff47ce98f1d1f904d59d7903080ab95120a89d0306971da6f7', main: '8e5c733527978bd3f1495d18b73b1b1232fcda85407df65aa1a94764203cdbea',
    resolve: LIVE_THEN_MAIN },
});

// Explicit live-topology adaptation: canonical SELF leave reads its authority on
// router output 7. On the installed router output 7 is the product continuation
// (lk_subscription_product_router_20260907) and no leave store exists, so SELF
// leave fails closed until the managed self-leave graph is installed.
const LEAVE_FIND_EMIT = '  delete msg.error;\n  return emit(7);\n};';
const LEAVE_FIND_CLOSED = '  delete msg.error;\n'
  + '  // Installed output 7 is the product continuation; SELF leave authority is not installed.\n'
  + '  return managedLeavePending(ctx, "MANAGED_SELF_LEAVE_GRAPH_UNAVAILABLE");\n};';
const PROBE_KEY = 'if:msg._subscriptionBooking?.step === "booked_operation_contract_probe"';
const PROBE_VERSIONS = '["1", "2", "3"].includes(ownerProbeVersion)';
const PROBE_VERSIONS_INSTALLED = '["1"].includes(ownerProbeVersion) /* 2 needs the JOIN v2 receiver, 3 the SELF leave graph */';

function diff3(live, base, main, temporary) {
  for (const [name, body] of [['live', live], ['base', base], ['main', main]]) {
    fs.writeFileSync(path.join(temporary, name), body + '\n', { mode: 0o600 });
  }
  const result = spawnSync('git', ['merge-file', '--diff3', '-p', '-L', 'LIVE', '-L', 'BASE', '-L', 'MAIN',
    ...['live', 'base', 'main'].map(name => path.join(temporary, name))], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status === null || result.status < 0 || result.status > 127) throw new Error('Local merge tool unavailable');
  return result;
}

const liveOnlyLines = (live, base) => {
  const known = new Set(base.split('\n'));
  return live.split('\n').filter(line => line.trim() && !known.has(line));
};

function mergeStatement(unit, key, live, base, main, temporary, relocations, decisions) {
  const result = diff3(live, base, main, temporary);
  let blocks = 0;
  const merged = result.stdout.replace(/<<<<<<< LIVE\n([\s\S]*?)\|\|\|\|\|\|\| BASE\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> MAIN\n/g,
    (_m, ours, original, theirs) => {
      blocks++;
      const rule = LIVE_REBASE_RESOLUTIONS[unit + '|' + key];
      if (!rule) throw new Error(`Unreviewed live rebase conflict: ${unit} ${key}`);
      if (original !== '' && !(rule.relocate && theirs.endsWith(original))) {
        throw new Error(`Live rebase conflict edits shared lines: ${unit} ${key}`);
      }
      if (hash(ours) !== rule.live || hash(theirs) !== rule.main || hash(original) !== (rule.base ?? hash(''))) {
        throw new Error(`Live rebase conflict drift: ${unit} ${key} live=${hash(ours)} main=${hash(theirs)} base=${hash(original)}`);
      }
      if (rule.relocate) relocations.push({ ...rule.relocate, text: theirs.slice(0, theirs.length - original.length), from: key });
      decisions.push({ unit, key, liveSha256: hash(ours), mainSha256: hash(theirs),
        decision: rule.relocate ? 'RELOCATE_MAIN:' + rule.relocate.key : rule.resolve === MAIN_THEN_LIVE ? 'MAIN_THEN_LIVE' : 'LIVE_THEN_MAIN' });
      return rule.resolve(ours, theirs);
    });
  if (blocks !== result.status || /^(?:<<<<<<<|=======|>>>>>>>|\|{7})/m.test(merged)) throw new Error(`Unresolved live rebase conflict: ${unit} ${key}`);
  const body = merged.replace(/\n$/, '');
  for (const line of liveOnlyLines(live, base)) if (!body.split('\n').includes(line)) throw new Error(`Live line lost: ${unit} ${key}`);
  return body;
}

const readBase = blob => execFileSync('git', ['cat-file', 'blob', blob], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
function readCanonical(files) {
  return files.map(([file, , sha]) => {
    const source = fs.readFileSync(path.join(ROOT, NODES, file), 'utf8');
    if (hash(source) !== sha) throw new Error(`Canonical source drift: ${file}`);
    return source;
  }).join('');
}

export function rebaseUnitSource(unit, liveSource, baseSource, canonicalSource, temporary) {
  const live = statements(liveSource), base = new Map(statements(baseSource).map(row => [row.key, row]));
  const canonical = statements(canonicalSource), wanted = new Map(canonical.map(row => [row.key, row]));
  const original = new Map(live.map(row => [row.key, row.body]));
  const present = new Set(live.map(row => row.key));
  for (const key of base.keys()) {
    if (!present.has(key)) throw new Error(`Installed base statement missing: ${unit} ${key}`);
    if (!wanted.has(key)) throw new Error(`Canonical removed a base statement: ${unit} ${key}`);
  }
  const taken = [], merged = [], added = [], relocations = [], decisions = [];
  for (const row of live) {
    const before = base.get(row.key), next = wanted.get(row.key);
    if (!before) {
      if (next && next.body !== row.body) throw new Error(`Unreviewed statement added on both sides: ${unit} ${row.key}`);
      continue;
    }
    if (next.body === before.body || next.body === row.body) continue;
    if (row.body === before.body) { row.body = next.body; taken.push(row.key); continue; }
    row.body = mergeStatement(unit, row.key, row.body, before.body, next.body, temporary, relocations, decisions);
    merged.push(row.key);
  }
  for (let i = canonical.length - 1; i >= 0; i--) {
    const row = canonical[i];
    if (present.has(row.key)) continue;
    const following = canonical.slice(i + 1).find(next => present.has(next.key));
    const index = following ? live.findIndex(next => next.key === following.key) : live.length;
    live.splice(index, 0, { ...row }); present.add(row.key); added.push(row.key);
  }
  const touchedLiveOnly = new Set();
  for (const move of relocations) {
    const target = live.find(row => row.key === move.key);
    if (!target || base.has(move.key) || wanted.has(move.key)) throw new Error(`Relocation target is not a live-only statement: ${move.key}`);
    if (target.body.split(move.before).length !== 2) throw new Error(`Relocation anchor drift: ${move.key}`);
    target.body = target.body.replace(move.before, () => move.text + move.before);
    touchedLiveOnly.add(move.key);
  }
  if (unit === 'router') {
    const leave = live.find(row => row.key === 'var:managedLeaveFind');
    if (!leave || leave.body.split(LEAVE_FIND_EMIT).length !== 2) throw new Error('SELF leave output anchor drift');
    leave.body = leave.body.replace(LEAVE_FIND_EMIT, () => LEAVE_FIND_CLOSED);
    // The capability probe advertises only what this graph completes end to end: JOIN v2 (2)
    // also needs the upgraded booked-operation receiver and SELF leave (3) fails closed here.
    const probe = live.find(row => row.key === PROBE_KEY);
    if (!probe || probe.body.split(PROBE_VERSIONS).length !== 2) throw new Error('Owner probe version anchor drift');
    probe.body = probe.body.replace(PROBE_VERSIONS, () => PROBE_VERSIONS_INSTALLED);
  }
  let protectedStatements = 0;
  for (const row of live) {
    if (base.has(row.key) || wanted.has(row.key)) continue;
    protectedStatements++;
    if (!touchedLiveOnly.has(row.key) && row.body !== original.get(row.key)) throw new Error(`Protected live statement changed: ${row.key}`);
  }
  const source = live.map(row => row.prefix + row.body).join('') + '\n';
  new Function('msg', 'global', 'node', 'env', 'context', 'flow', source);
  return { source, taken, merged, added, decisions, protectedStatements };
}

export function rebaseOwnerUnits(flow) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phub-owner-live-rebase-'));
  try {
    const candidate = structuredClone(flow), reports = [];
    for (const [id, sha] of Object.entries(LIVE_REBASE_UNCHANGED)) {
      const node = candidate.find(row => row.id === id);
      if (node?.type !== 'function' || hash(node.func) !== sha) throw new Error(`Unchanged unit preimage drift: ${id}`);
    }
    for (const [name, id, files, liveSha] of LIVE_REBASE_UNITS) {
      const node = candidate.find(row => row.id === id);
      if (node?.type !== 'function' || hash(node.func) !== liveSha) throw new Error(`Live ${name} preimage drift`);
      const base = files.map(([, blob]) => readBase(blob)).join('');
      const result = rebaseUnitSource(name, node.func, base, readCanonical(files), temporary);
      node.func = result.source;
      reports.push({ id, name, sourceSha256: liveSha, candidateSha256: hash(node.func),
        takenStatements: result.taken.length, mergedStatements: result.merged, addedStatements: result.added.length,
        conflictDecisions: result.decisions, protectedStatements: result.protectedStatements });
    }
    return { candidate, reports };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
