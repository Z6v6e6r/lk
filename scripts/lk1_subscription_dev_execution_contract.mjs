// Configuration hashes attest identity; they do not prove execution semantics.
export const hasUniqueFlowIds = (flow) => Array.isArray(flow)
  && flow.every((node) => typeof node?.id === "string" && node.id.length > 0)
  && new Set(flow.map((node) => node.id)).size === flow.length;

export const hasSafeDevHttpSemantics = (node) => node?.type === "http request"
  && node.method === "use" && node.ret === "obj" && node.paytoqs === "ignore"
  && node.url === "" && node.requestTimeout === "20000"
  && node.senderr === true && node.persist === false
  && node.authType === "" && node.insecureHTTPParser === false
  && !node.tls && !node.proxy
  && (node.headers === undefined || (Array.isArray(node.headers) && node.headers.length === 0));

const ISOLATED_NODE_TYPES = new Set([
  "tab", "comment", "http in", "http response", "function", "catch", "debug",
  "http request", "mongodb4", "mongodb4-client",
]);

export const deriveDevWholeFlowIsolation = (flow) => {
  const violations = [];
  if (!Array.isArray(flow)) return { verified: false, violations: ["flow:not-array"] };
  for (const node of flow) {
    if (!ISOLATED_NODE_TYPES.has(node?.type)) violations.push(`${node?.id || "<missing>"}:type:${node?.type || "<missing>"}`);
    if (node?.type === "function" && Array.isArray(node.libs) && node.libs.length > 0) {
      violations.push(`${node.id}:function-libs`);
    }
    if (node?.type === "debug" && (
      node.active !== false || node.console !== false || node.tostatus !== false
      || node.complete !== "payload" || node.targetType !== "msg"
    )) violations.push(`${node.id}:debug-not-inert`);
  }
  return { verified: violations.length === 0, violations };
};
