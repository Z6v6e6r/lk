// Transient probe: re-pin one focused patcher against the live snapshot and try to compose.
// Usage: node outputs/lk1-train-147-prep-20261005/tools/probe-repin.mjs <patcher> <liveFlow>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");

const patcherName = process.argv[2];
const livePath = process.argv[3];
const liveBytes = fs.readFileSync(livePath);
const live = JSON.parse(liveBytes.toString("utf8"));
const byId = new Map(live.map((n) => [n.id, n]));
const f = (id) => {
  const n = byId.get(id);
  if (!n) throw new Error("missing node " + id);
  return n.func;
};
const init = (id) => byId.get(id).initialize;

let source = fs.readFileSync(path.join(ROOT, "scripts", patcherName), "utf8");
const repl = [];
const setConst = (name, value) => {
  const re = new RegExp(`(export const ${name} = Object\\.freeze\\(\\{[\\s\\S]*?\\}\\);)`, "m");
  if (!re.test(source)) { repl.push(`!! could not locate ${name}`); return; }
  // handled separately
};
// Replace a simple `export const NAME = 'value';` (or double quotes).
const setSimple = (name, value, quote = "'") => {
  const re = new RegExp(`(export const ${name}\\s*=\\s*)(['"\`])([^'"\`]*)\\2(;)`, "m");
  if (!re.test(source)) { repl.push(`!! could not locate ${name}`); return false; }
  source = source.replace(re, (m, p1, q, old, p4) => {
    repl.push(`${name}: ${old} -> ${value}`);
    return `${p1}${quote}${value}${quote}${p4}`;
  });
  return true;
};
const setNumber = (name, value) => {
  const re = new RegExp(`(export const ${name}\\s*=\\s*)(\\d+)(;)`, "m");
  if (!re.test(source)) { repl.push(`!! could not locate ${name}`); return false; }
  source = source.replace(re, (m, p1, old, p3) => {
    repl.push(`${name}: ${old} -> ${value}`);
    return `${p1}${value}${p3}`;
  });
  return true;
};
// Replace a key inside an exported frozen object literal.
const setObjectKey = (objectName, key, value, quote = "'") => {
  const objRe = new RegExp(`export const ${objectName} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`, "m");
  const match = source.match(objRe);
  if (!match) { repl.push(`!! could not locate object ${objectName}`); return false; }
  const body = match[1];
  const keyRe = new RegExp(`(\\b${key}:\\s*)(['"\`])([^'"\`]*)\\2`, "m");
  if (!keyRe.test(body)) { repl.push(`!! could not locate ${objectName}.${key}`); return false; }
  const newBody = body.replace(keyRe, (m, p1, q, old) => {
    repl.push(`${objectName}.${key}: ${old} -> ${value}`);
    return `${p1}${quote}${value}${quote}`;
  });
  source = source.replace(objRe, `export const ${objectName} = Object.freeze({${newBody}\n});`);
  return true;
};

// Derived live values, keyed by patcher.
const targets = {
  "patch_live_lk1_patriots_friendship.mjs": () => {
    setSimple("PATRIOTS_SOURCE_SHA256", sha(liveBytes));
    setNumber("PATRIOTS_SOURCE_NODE_COUNT", live.length);
    setObjectKey("PATRIOTS_PREIMAGE", "gatewayFunc", sha(f("lk_subscription_booking_router_20260804")));
    setObjectKey("PATRIOTS_PREIMAGE", "gatewayInitialize", sha(init("lk_subscription_booking_router_20260804")));
    setObjectKey("PATRIOTS_PREIMAGE", "evaluatorFunc", sha(f("lk_subscription_managed_policy_20260820")));
    setObjectKey("PATRIOTS_PREIMAGE", "previewFunc", sha(f("lk_subscription_price_preview_20260908_router")));
    setObjectKey("PATRIOTS_PREIMAGE", "previewEvaluatorFunc", sha(f("lk_subscription_price_preview_20260908_evaluate")));
    setObjectKey("PATRIOTS_PREIMAGE", "pricingFunc", sha(f("8f7bd5b482fe9763")));
    setObjectKey("PATRIOTS_PREIMAGE", "joinFunc", sha(f("e92e68bf3f08a70c")));
    setObjectKey("PATRIOTS_PREIMAGE", "reviewedGatewaySource", sha(fs.readFileSync(path.join(ROOT, "scripts/nodered_lk1_hub_nodes/gateway.js"))));
    setObjectKey("PATRIOTS_PREIMAGE", "reviewedGatewayHooksSource", sha(fs.readFileSync(path.join(ROOT, "scripts/nodered_lk1_hub_nodes/gateway_hooks.js"))));
    setObjectKey("PATRIOTS_PREIMAGE", "reviewedEvaluatorSource", sha(fs.readFileSync(path.join(ROOT, "scripts/nodered_lk1_hub_nodes/evaluator.js"))));
    setObjectKey("PATRIOTS_PREIMAGE", "reviewedBookingRouterSource", sha(fs.readFileSync(path.join(ROOT, "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js"))));
    setObjectKey("PATRIOTS_PREIMAGE", "reviewedPreviewSource", sha(fs.readFileSync(path.join(ROOT, "scripts/nodered_subscription_price_preview_nodes/router.js"))));
    // embedded bodies
    const EVAL_OPEN = 'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n  return (() => {\n';
    const EVAL_CLOSE = "\n})();\n}";
    const embedded = (body) => {
      const s = body.indexOf(EVAL_OPEN) + EVAL_OPEN.length;
      const e = body.indexOf(EVAL_CLOSE, s);
      return sha(body.slice(s, e));
    };
    setObjectKey("PATRIOTS_PREIMAGE", "evaluatorEmbedded", embedded(f("lk_subscription_managed_policy_20260820")));
    setObjectKey("PATRIOTS_PREIMAGE", "previewEvaluatorEmbedded", embedded(f("lk_subscription_price_preview_20260908_evaluate")));
    const g = f("lk_subscription_booking_router_20260804");
    const us = g.slice(g.indexOf('if (ctx.step === "lk1_usage_operations") {'), g.indexOf('if (ctx.step === "lk1_policy_decision") {'));
    setObjectKey("PATRIOTS_PREIMAGE", "usageBlock", sha(us));
  },
};

if (!targets[patcherName]) { console.error("unknown patcher " + patcherName); process.exit(2); }
targets[patcherName]();
const tmpName = ".probe-" + patcherName;
fs.writeFileSync(path.join(ROOT, "scripts", tmpName), source);
console.log(repl.join("\n"));
const mod = await import(path.join(ROOT, "scripts", tmpName));
try {
  const out = mod.composePatriotsArtifacts(liveBytes, { assertPostimages: false });
  console.log("COMPOSE_OK candidateSha256=" + out.candidateSha256);
  console.log("postimages=" + JSON.stringify(out.postimages, null, 2));
} catch (error) {
  console.log("COMPOSE_FAIL " + error.message);
}
fs.unlinkSync(path.join(ROOT, "scripts", tmpName));
