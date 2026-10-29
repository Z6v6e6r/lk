// Run on 147 via stdin. The full flow and all config/credential nodes stay on 147.
// Export hashes and structural assertions only, never function bodies or rules.
import fs from "node:fs";
import crypto from "node:crypto";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const bytes = fs.readFileSync("/root/.node-red/flows.json"), flow = JSON.parse(bytes);
const allowed = [
  "4f0f1ce8189a9e8c", "2e70b2e547e77c00", "f476ee4e8d98c43b", "7ea8ad4e0b4105b5", "91fc0ea29c45e1df",
  "a73c590f8f001001", "a73c590f8f001002", "745f991e11130b08",
  "tournament_history_request_guard_20260817", "tournament_history_cache_store_20260817",
  "tournament_community_history_query_20260811",
];
const nodes = allowed.map(id => {
  const node = flow.find(n => n.id === id);
  if (!node || !["function", "change"].includes(node.type)) throw new Error("Expected scoped node missing: " + id);
  const code = node.func ?? JSON.stringify(node.rules);
  return { id: node.id, type: node.type, name: node.name, wires: node.wires,
    sha256: sha(code), codeExported: false,
    ...(node.type === "change" ? {
      copiesCasQuery: node.rules?.some(r => r.t === "set" && r.p === "query" && r.pt === "msg" && r.to === "mongoQuery" && r.tot === "msg") === true,
      copiesAtomicUpdate: node.rules?.some(r => r.t === "set" && r.p === "payload" && r.pt === "msg" && r.to === "mongoUpdate" && r.tot === "msg") === true,
    } : {}),
    ...(id === "tournament_history_request_guard_20260817" ? { recognizesFpr: code.includes("fpr_6x25"), recognizesReadback: code.includes("readback") } : {}),
  };
});
const workerRoot = "/opt/padlhub-rating-worker/current";
const workerFiles = ["scripts/rating_worker.mjs", "scripts/lib/tournamentFinalization.mjs", "src/services/community-rating/facts.ts", "src/services/player-rating/ledger.ts"];
const worker = { root: fs.realpathSync(workerRoot), files: {} };
for (const file of workerFiles) {
  const path = `${workerRoot}/${file}`;
  worker.files[file] = fs.existsSync(path) ? sha(fs.readFileSync(path)) : null;
}
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), readonly: true, fullFlowExported: false,
  flowSha256: sha(bytes), nodeCount: flow.length, nodes, worker }));
