import test from "node:test";
import assert from "node:assert/strict";

import { analyzeFlow } from "../tenant_clone_flow.mjs";
import { parseTenantProfile } from "../lib/tenantCloneProfile.mjs";

const TAB_GAMES = "aaaaaaaaaaaaaaaa";
const TAB_OTHER = "bbbbbbbbbbbbbbbb";
const CLIENT = "cccccccccccccccc";

const profile = parseTenantProfile({
  slug: "pade_prime",
  vivaTenant: "Dvjlor",
  pathPrefix: "/pade-prime",
  collectionPrefix: "pp_",
  timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" },
  tabs: ["LK Games"],
  reuseConfigNodeIds: [CLIENT],
  dropHttpIn: ["^/lk/subscriptions", "/split/"],
  vivaIds: { 4588: null },
});

const buildFlow = () => ([
  { id: TAB_GAMES, type: "tab", label: "LK Games" },
  { id: TAB_OTHER, type: "tab", label: "БИТРИКС" },
  { id: CLIENT, type: "mongodb4-client", dbName: "games", uri: "mongodb://user:secret@host/db" },

  { id: "1111111111111111", type: "http in", z: TAB_GAMES, url: "/lk/games", method: "get", wires: [["2222222222222222"]] },
  {
    id: "2222222222222222",
    type: "function",
    z: TAB_GAMES,
    func: 'const tenant = "iSkq6G";\nconst iso = `${date}T${time}:00+03:00`;\nconst ids = [4588];\nconst tz = "Europe/Moscow";',
    wires: [["3333333333333333"]],
  },
  { id: "3333333333333333", type: "mongodb4", z: TAB_GAMES, clientNode: CLIENT, collection: "lk_games", operation: "find", wires: [[]] },

  { id: "4444444444444444", type: "http in", z: TAB_GAMES, url: "/lk/subscriptions/product", method: "get", wires: [["5555555555555555"]] },
  { id: "5555555555555555", type: "function", z: TAB_GAMES, func: "return msg;", wires: [[]] },

  { id: "6666666666666666", type: "http in", z: TAB_GAMES, url: "/lk/games/split/create", method: "post", wires: [["7777777777777777"]] },
  { id: "7777777777777777", type: "function", z: TAB_GAMES, func: "return msg;", wires: [[]] },

  { id: "8888888888888888", type: "function", z: TAB_OTHER, func: "return msg;", wires: [[]] },
]);

test("clones only the tenant tab and rewrites tenant, timezone and dictionary ids", () => {
  const { candidate, report } = analyzeFlow({ flow: buildFlow(), profile });

  const serialized = JSON.stringify(candidate);
  assert.equal(serialized.includes("iSkq6G"), false, "source tenant token must not survive");
  assert.equal(serialized.includes("Europe/Moscow"), false, "source timezone must not survive");
  assert.match(serialized, /Dvjlor/);
  assert.match(serialized, /\+07:00/);
  assert.match(serialized, /Asia\/Krasnoyarsk/);
  assert.equal(candidate.some((node) => node.z === TAB_OTHER), false, "unrelated tabs must be dropped");
  assert.equal(candidate.some((node) => node.id === CLIENT), false, "reused config node must not be duplicated");
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
});

test("prefixes http-in paths and collection names", () => {
  const { candidate } = analyzeFlow({ flow: buildFlow(), profile });
  const httpIn = candidate.filter((node) => node.type === "http in");
  assert.ok(httpIn.length > 0);
  for (const node of httpIn) assert.ok(node.url.startsWith("/pade-prime"), node.url);
  const mongo = candidate.filter((node) => node.type === "mongodb4");
  assert.ok(mongo.length > 0);
  for (const node of mongo) assert.ok(node.collection.startsWith("pp_"), node.collection);
});

test("drops excluded endpoints and prunes their exclusive branches", () => {
  const { candidate, report } = analyzeFlow({ flow: buildFlow(), profile });
  const urls = candidate.filter((node) => node.type === "http in").map((node) => node.url);
  assert.equal(urls.some((url) => url.includes("/subscriptions")), false);
  assert.equal(urls.some((url) => url.includes("/split/")), false);
  assert.equal(report.counts.droppedHttpIn, 2);
  assert.equal(report.counts.prunedNodes, 4, "both dropped endpoints and both exclusive function nodes must be pruned");
  const ids = new Set(candidate.map((node) => node.id));
  for (const droppedId of ["4444444444444444", "5555555555555555", "6666666666666666", "7777777777777777"]) {
    assert.equal(ids.has(droppedId), false, `dropped node ${droppedId} survived`);
  }
});

test("remaps ids and keeps wires resolvable", () => {
  const { candidate } = analyzeFlow({ flow: buildFlow(), profile });
  const ids = new Set(candidate.map((node) => node.id));
  assert.equal(ids.size, candidate.length);
  for (const node of candidate) {
    for (const wire of node.wires || []) {
      for (const target of wire) {
        assert.ok(ids.has(target) || target === CLIENT, `dangling wire ${target}`);
      }
    }
  }
  const tab = candidate.find((node) => node.type === "tab");
  assert.ok(tab && !ids.has(TAB_GAMES), "tab id must be remapped");
  for (const node of candidate) {
    if (node.z) assert.ok(ids.has(node.z), `node ${node.id} points at unknown tab ${node.z}`);
  }
});

test("reports unresolved Viva dictionary ids instead of silently keeping them", () => {
  const { report } = analyzeFlow({ flow: buildFlow(), profile });
  assert.deepEqual(report.unresolvedVivaIds, ["4588"]);
  assert.equal(report.deployable, false, "unresolved dictionary ids must block deployment");
});

test("fails closed when a cloned node carries a secret-bearing field", () => {
  const flow = buildFlow();
  // Wired from a kept endpoint, so pruning cannot hide it from validation.
  flow.push({
    id: "9999999999999999",
    type: "mongodb4-client",
    z: TAB_GAMES,
    uri: "mongodb://user:secret@host/db",
    wires: [[]],
  });
  const host = flow.find((node) => node.id === "1111111111111111");
  host.wires = [["2222222222222222", "9999999999999999"]];
  const { report } = analyzeFlow({ flow, profile });
  assert.ok(report.errors.some((error) => error.includes('"uri"')), report.errors.join("\n"));
});

test("rejects a profile whose identifiers are unsafe", () => {
  assert.throws(() => parseTenantProfile({ slug: "Bad Slug", vivaTenant: "Dvjlor", pathPrefix: "/x", collectionPrefix: "pp_", timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" }, tabs: ["LK Games"] }), /slug/);
  assert.throws(() => parseTenantProfile({ slug: "ok_slug", vivaTenant: "Dvjlor", pathPrefix: "pade", collectionPrefix: "pp_", timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" }, tabs: ["LK Games"] }), /pathPrefix/);
  assert.throws(() => parseTenantProfile({ slug: "ok_slug", vivaTenant: "Dvjlor", pathPrefix: "/pade", collectionPrefix: "prefix", timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" }, tabs: ["LK Games"] }), /collectionPrefix/);
  assert.throws(() => parseTenantProfile({ slug: "ok_slug", vivaTenant: "Dvjlor", pathPrefix: "/pade", collectionPrefix: "pp_", timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" }, tabs: [] }), /at least one source tab/);
});

test("applies exact body replacements for tenant dictionary constants", () => {
  const dictionaryProfile = parseTenantProfile({
    slug: "pade_prime",
    vivaTenant: "Dvjlor",
    pathPrefix: "/pade-prime",
    collectionPrefix: "pp_",
    timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" },
    tabs: ["LK Games"],
    reuseConfigNodeIds: [CLIENT],
    bodyReplacements: [
      { find: "const dictIds = [4588];", replace: "const dictIds = [];" },
      { find: "const dictTypes = [605, 847];", replace: "const dictTypes = [524];" },
    ],
    vivaIds: {},
  });
  const flow = buildFlow();
  const fn = flow.find((node) => node.id === "2222222222222222");
  fn.func = `${fn.func}\nconst dictIds = [4588];\nconst dictTypes = [605, 847];`;
  const { candidate, report } = analyzeFlow({ flow, profile: dictionaryProfile });
  const body = candidate.find((node) => node.type === "function" && node.func.includes("const dictIds")).func;
  assert.match(body, /const dictIds = \[\];/);
  assert.match(body, /const dictTypes = \[524\];/);
  assert.equal(report.appliedBodyReplacements, 2);
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
});

test("fails when a required body replacement is missing from the live source", () => {
  const staleProfile = parseTenantProfile({
    slug: "pade_prime",
    vivaTenant: "Dvjlor",
    pathPrefix: "/pade-prime",
    collectionPrefix: "pp_",
    timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" },
    tabs: ["LK Games"],
    bodyReplacements: [{ find: "const gone = [9999];", replace: "const gone = [];" }],
    vivaIds: {},
  });
  const { report } = analyzeFlow({ flow: buildFlow(), profile: staleProfile });
  assert.ok(report.errors.some((error) => error.includes("required body replacement")), report.errors.join("\n"));
});

test("a declared owner blocker keeps the candidate non-deployable", () => {
  const blockedProfile = parseTenantProfile({
    slug: "pade_prime",
    vivaTenant: "Dvjlor",
    pathPrefix: "/pade-prime",
    collectionPrefix: "pp_",
    timezone: { offset: "+07:00", iana: "Asia/Krasnoyarsk" },
    tabs: ["LK Games"],
    vivaIds: {},
    blockers: ["нет направления открытой игры в Viva"],
  });
  const { report } = analyzeFlow({ flow: buildFlow(), profile: blockedProfile });
  assert.deepEqual(report.blockers, ["нет направления открытой игры в Viva"]);
  assert.equal(report.deployable, false);
});
