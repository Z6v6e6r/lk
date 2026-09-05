// Exact local update of the already installed atomic graph. These are not
// activation permission or a claim about the current production flow.
export const PITER_QUOTA_UPDATE = Object.freeze({
  deploymentId: "piter-atomic-sales-20260903",
  updateKind: "existing-atomic-quota-v2",
  sourceSha256: "7775475aea2436ca5d6ec26cdc6acc4c682556f05b71af2fb79f6e0c0edbcb71",
  candidateSha256: "8cc76edc46bd97ec4dd83b1e09402242ce28d5c3f2ee221490fd8120978f39df",
  sourceNodeCount: 4768,
  candidateNodeCount: 4768,
  httpInputCount: 215,
  targets: Object.freeze([
    Object.freeze({
      id: "c165e43eba668c25", name: "Build tournament subscription status", outputs: 2,
      file: "fn_tournament_subscription_status_response.js",
      sourceSha256: "e81699c4c490b9883cacf104c751990c0b2922ce86d1f607889fb66991fedb53",
      candidateSha256: "52e1d932916a8ee139842c4ff861dba38cf4602a3e392d4e29997d796973f40a",
    }),
    Object.freeze({
      id: "piter_atomic_router_20260903", name: "Route atomic Piter subscription sale", outputs: 5,
      file: "fn_tournament_subscription_piter_atomic_router.js",
      sourceSha256: "fe097554fb070cbf7e076ee907c90f4448317424650d7804eb2151b2d9372a6c",
      candidateSha256: "7283aec32b1a9e9b3c3ae0d76bc14d1214c4b2a27b9d4a8821619e61149deaf4",
    }),
  ]),
});

export const isExactPiterQuotaUpdateDeployment = (value) => Boolean(value && [
  "deploymentId", "sourceSha256", "candidateSha256", "sourceNodeCount", "candidateNodeCount",
].every((key) => value[key] === PITER_QUOTA_UPDATE[key]));
