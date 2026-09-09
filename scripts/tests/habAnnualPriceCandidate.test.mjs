import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { buildHabAnnualPriceCandidate } from "../prepare_hab_annual_price_candidate.mjs";
import { validateExactGraphContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";
const sourceDir = new URL("../nodered_games_nodes/", import.meta.url);
const ids = ["8fdc7076a0c436a2", "c165e43eba668c25", "91dded2dc8cfebe4", "519b6a6ca208e281"];
const binding = JSON.parse(fs.readFileSync(new URL("../subscription_sale_opening_binding.json", import.meta.url)));
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function fixture() {
  return [{ id: "f9575c8726e29196", type: "tab" },
    ...binding.targets.filter(t => ids.includes(t.id)).map(t => ({
      id: t.id, name: t.name, type: "function", z: "f9575c8726e29196", outputs: t.outputs,
      initialize: "", wires: Array.from({ length: t.outputs }, () => []),
      func: fs.readFileSync(new URL(t.file, sourceDir), "utf8")
        .replace('// Change only new HAB purchase prices; quota and admission flags remain independent.\nconst HUB_PRICE_98000_ENABLED = SALES_QUOTAS_20260909_ENABLED\n  || global.get("summer_subscription_network_friendship_price_98000_enabled") === true;\n', "")
        .replaceAll("HUB_PRICE_98000_ENABLED ? 9800000", "SALES_QUOTAS_20260909_ENABLED ? 9800000"),
    })), { id: "unrelated", type: "function", func: "return msg;", wires: [] }];
}
const initializer = fs.readFileSync(new URL("init_hab_annual_price_98000.js", sourceDir), "utf8");
function start(store, write = (key, value) => { store[key] = value; }) {
  vm.runInNewContext(initializer, { global: { get: key => store[key], set: write } });
}
test("startup price survives independent memory-store restarts without changing admission or quota flags", () => {
  const baseline = { summer_subscription_sales_20260909_enabled: false,
    summer_subscription_hub_lk1_sales_enabled: false, unrelated: "preserved" };
  for (let restart = 0; restart < 3; restart++) {
    const store = structuredClone(baseline);
    start(store); start(store);
    assert.deepEqual(store, { ...baseline, summer_subscription_network_friendship_price_98000_enabled: true });
  }
  assert.throws(() => start({}, () => {}), /readback mismatch/);
});
test("candidate changes only four funcs and the exact empty startup field; reverse restores source", () => {
  const source = fixture(); const before = structuredClone(source); const liveBytes = bytes(source);
  const result = buildHabAnnualPriceCandidate(liveBytes);
  const after = JSON.parse(result.candidateBytes);
  assert.deepEqual(source, before);
  assert.deepEqual(after.find(n => n.id === "unrelated"), source.find(n => n.id === "unrelated"));
  assert.equal(after.find(n => n.id === ids[0]).initialize, initializer);
  assert.equal(result.contract.allowedChanges.length, 4);
  for (const c of result.contract.allowedChanges) assert.deepEqual(c.fields, c.id === ids[0] ? ["func", "initialize"] : ["func"]);
  validateExactGraphContract({ liveBytes: result.candidateBytes, candidateBytes: liveBytes, contract: result.reverse });
  assert.equal(result.report.deploymentPerformed, false);
});
test("candidate rejects altered source, occupied startup hooks, missing and duplicate targets", () => {
  for (const change of [flow => { flow.find(n => n.id === ids[0]).func += "\n"; },
    flow => { flow.find(n => n.id === ids[0]).initialize = "existing startup work"; },
    flow => { flow.splice(flow.findIndex(n => n.id === ids[0]), 1); },
    flow => { flow.push(structuredClone(flow.find(n => n.id === ids[0]))); }]) {
    const flow = fixture(); change(flow); assert.throws(() => buildHabAnnualPriceCandidate(bytes(flow)));
  }
});
test("reviewed contract rejects any extra live topology or admission change", () => {
  const liveBytes = bytes(fixture()); const result = buildHabAnnualPriceCandidate(liveBytes);
  const candidate = JSON.parse(result.candidateBytes);
  candidate.find(n => n.id === ids[1]).wires = [["unrelated"], []];
  assert.throws(() => validateExactGraphContract({ liveBytes, candidateBytes: bytes(candidate), contract: result.contract }));
});
test("fresh private production snapshot builds with exact four-node scope", {
  skip: !process.env.HAB_PRICE_LIVE_FIXTURE,
}, () => {
  const liveBytes = fs.readFileSync(process.env.HAB_PRICE_LIVE_FIXTURE);
  const result = buildHabAnnualPriceCandidate(liveBytes);
  assert.equal(result.report.changedNodeCount, 4); assert.equal(result.report.addedNodeCount, 0);
});
