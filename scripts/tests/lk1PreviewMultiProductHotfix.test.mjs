// Focused generation: the subscription price preview prices an event for a client who owns
// more than one managed product.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_MULTI_PRODUCT_DELTAS,
  PREVIEW_MULTI_PRODUCT_NODE_ID,
  PREVIEW_MULTI_PRODUCT_SOURCE_NODE_COUNT,
  PREVIEW_MULTI_PRODUCT_SOURCE_SHA256,
  PREVIEW_MULTI_PRODUCT_TARGET,
  composePreviewMultiProductArtifacts,
  patchPreviewMultiProductBody,
  sha256,
} from "../patch_live_lk1_preview_multi_product_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTER_SOURCE = "scripts/nodered_subscription_price_preview_nodes/router.js";
const LIVE_DUMP = process.env.LK1_PREVIEW_LIVE_FUNC ?? "/private/tmp/preview_router.js";
const dumpSkip = fs.existsSync(LIVE_DUMP)
  ? false
  : `live 147 preview router dump is absent: ${LIVE_DUMP} (set LK1_PREVIEW_LIVE_FUNC)`;

/** The guard expression the delta installs, evaluated on its own. */
function guardProbe(patchedBody) {
  const marker = "if (ctx.operations.some(row => !ctx.ruleProductIds.includes(";
  const start = patchedBody.indexOf(marker);
  assert.notEqual(start, -1, "the reviewed guard is absent from the patched body");
  const line = patchedBody.slice(start, patchedBody.indexOf("\n", start)).replace(/ \{$/, "");
  const factory = new Function("ctx", `return (${line.replace(/^if \(/, "").replace(/\)$/, "")});`);
  return (ctx) => factory(ctx);
}

test("the generation pins the installed flow and one node field", () => {
  assert.equal(PREVIEW_MULTI_PRODUCT_SOURCE_NODE_COUNT, 4804);
  assert.equal(PREVIEW_MULTI_PRODUCT_SOURCE_SHA256,
    "8fce2cebb3703c6cd9575932a000a2330ce61e16c03a50406e3daf11bffeec1e");
  assert.equal(PREVIEW_MULTI_PRODUCT_NODE_ID, "lk_subscription_price_preview_20260908_router");
  assert.equal(PREVIEW_MULTI_PRODUCT_TARGET.liveFuncSha256,
    "976ce14ef9d6be1b2c00d818f1048b47a7ef3c61a8dfa6bdbb2a07b2f4c8466d");
  assert.equal(PREVIEW_MULTI_PRODUCT_TARGET.patchedFuncSha256,
    "6bbae1f64480fa9b22c3ca434157af8ea9447b7b486f2699f445bfb776b97331");
  assert.equal(PREVIEW_MULTI_PRODUCT_DELTAS.length, 1);
});

test("the reviewed router carries the reviewed delta verbatim", () => {
  const reviewed = fs.readFileSync(path.join(repoRoot, ROUTER_SOURCE), "utf8");
  for (const delta of PREVIEW_MULTI_PRODUCT_DELTAS) {
    assert.equal(reviewed.split(delta.before).length - 1, 0, `reviewed router keeps the preimage of ${delta.id}`);
    assert.equal(reviewed.split(delta.after).length - 1, 1, `reviewed router drift for ${delta.id}`);
  }
});

test("the deltas apply and revert on the installed body only", { skip: dumpSkip }, () => {
  const live = fs.readFileSync(LIVE_DUMP, "utf8");
  assert.equal(sha256(live), PREVIEW_MULTI_PRODUCT_TARGET.liveFuncSha256);
  const patched = patchPreviewMultiProductBody(live);
  assert.equal(sha256(patched), PREVIEW_MULTI_PRODUCT_TARGET.patchedFuncSha256);
  for (const delta of PREVIEW_MULTI_PRODUCT_DELTAS) {
    assert.equal(patched.split(delta.after).length - 1, 1, `missing ${delta.id}`);
    assert.equal(patched.split(delta.before).length - 1, 0, `preimage kept for ${delta.id}`);
  }
  assert.equal(patched.replace(deltaOf(), () => PREVIEW_MULTI_PRODUCT_DELTAS[0].before), live);
});

function deltaOf() {
  return PREVIEW_MULTI_PRODUCT_DELTAS[0].after;
}

test("the generation refuses any flow that is not the installed one", { skip: dumpSkip }, () => {
  const live = fs.readFileSync(LIVE_DUMP, "utf8");
  const flow = [{ id: PREVIEW_MULTI_PRODUCT_NODE_ID, type: "function", func: live, outputs: 6,
    wires: [[], [], [], [], [], []], initialize: "// keep" }, { id: "tab", type: "tab" }];
  const bytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  assert.throws(() => composePreviewMultiProductArtifacts(bytes, "lk1-preview-multi-product"), /preimage drift/);
  assert.throws(() => patchPreviewMultiProductBody("const x = 1;\n"), /preimage drift/);
});

test("a mixed-product batch is accepted and a foreign product is not", () => {
  const { after } = PREVIEW_MULTI_PRODUCT_DELTAS[0];
  const guard = guardProbe(after);
  const RA = "b91e14d1-fe6e-4d0b-be39-3e45ad86b759";
  const HUB = "db7a5250-7369-4f43-8ac5-9111be24bc74";
  const ops = (products) => products.map((productId) => ({ lk1: { rule: { productId } } }));

  // The live defect: a batch holding HUB and plan records was rejected for both rule products.
  assert.equal(guard({ operations: ops([HUB, RA]), ruleProductIds: [HUB, RA] }), false);
  assert.equal(guard({ operations: ops([HUB]), ruleProductIds: [HUB, RA] }), false);
  assert.equal(guard({ operations: ops([RA]), ruleProductIds: [RA] }), false);
  assert.equal(guard({ operations: [], ruleProductIds: [RA] }), false);
  // A record outside the queried scope, an unreadable record or a missing product still refuses.
  assert.equal(guard({ operations: ops(["3b4806f1-6f9a-46df-a7d7-45075b4e7274"]), ruleProductIds: [RA] }), true);
  assert.equal(guard({ operations: [{ lk1: {} }], ruleProductIds: [RA] }), true);
  assert.equal(guard({ operations: [{}], ruleProductIds: [RA] }), true);
  assert.equal(guard({ operations: ops([RA.toUpperCase()]), ruleProductIds: [RA] }), false);
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(path.join(repoRoot,
    "scripts/deploy_nodered_lk1_preview_multi_product_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes("NODE_RED_LK1_PREVIEW_MULTI_PRODUCT_DEPLOY"));
  assert.ok(wrapper.includes('deployment_id="lk1-preview-multi-product"'));
  assert.ok(wrapper.includes("lk_subscription_price_preview_20260908_router:func"));
  assert.ok(wrapper.includes("scripts/patch_live_lk1_preview_multi_product_hotfix.mjs"));
  assert.ok(wrapper.includes("rollback"));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("value.booking?.batchScopeMatchesQuery !== true"));
  assert.ok(wrapper.includes("value.booking?.usageBuilderUnchanged !== true"));
  assert.ok(!wrapper.includes("freeEventCarriesZeroChargeBinding"));
});
