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

const TARGET_FUNCTION_FIELDS = [
  "routerNodeId", "prepareNodeId", "splitRouterNodeId",
  "splitCreatePrepareNodeId", "splitJoinPrepareNodeId", "finalizeNodeId",
];
const FIXED_EXECUTION_NODE_IDS = new Set([
  "lk_subscription_booking_http_20260804",
  "ee7ba8cdd68bdf74",
  "lk_subscription_booking_find_20260804",
  "lk_subscription_booking_insert_20260804",
  "lk_subscription_booking_update_20260804",
]);
const AUXILIARY_FUNCTION_NODE_IDS = new Set([
  "lk_subscription_managed_policy_20260820",
  "lk_subscription_managed_policy_blocked_20260820",
  "lk_subscription_booking_mongo_error_20260804",
  "lk_subscription_booking_options_20260804",
]);
const HTTP_ROUTE_SPECS = Object.freeze([
  {
    id: "lk_subscription_booking_post_20260804",
    method: "post",
    url: "/lk/subscription-bookings",
    target: (target) => target.prepareNodeId,
  },
  {
    id: "lk_subscription_booking_options_in_20260804",
    method: "options",
    url: "/lk/subscription-bookings",
    target: () => "lk_subscription_booking_options_20260804",
  },
]);

export const deriveDevWholeFlowIsolation = (flow, target = null) => {
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
  if (!target) {
    violations.push("execution-contract:missing-target");
    return { verified: false, violations };
  }
  const byId = new Map(flow.map((node) => [node?.id, node]));
  const targetFunctionValues = TARGET_FUNCTION_FIELDS.map((field) => target?.[field]);
  const targetFunctionIds = new Set(targetFunctionValues);
  for (const id of AUXILIARY_FUNCTION_NODE_IDS) targetFunctionIds.add(id);
  if (targetFunctionValues.some((id) => typeof id !== "string" || !id)
    || new Set(targetFunctionValues).size !== TARGET_FUNCTION_FIELDS.length) {
    violations.push("execution-contract:target-function-inventory");
  }
  const routes = flow.filter((node) => node?.type === "http in");
  const responses = flow.filter((node) => node?.type === "http response");
  const routeIds = routes.map((node) => node.id).sort();
  if (JSON.stringify(routeIds) !== JSON.stringify(HTTP_ROUTE_SPECS.map((spec) => spec.id).sort())
    || HTTP_ROUTE_SPECS.some((spec) => {
      const route = byId.get(spec.id);
      return route?.type !== "http in"
        || String(route.method || "").toLowerCase() !== spec.method
        || route.url !== spec.url
        || JSON.stringify(route.wires) !== JSON.stringify([[spec.target(target)]]);
    })) {
    violations.push("execution-contract:http-route");
  }
  const responseIds = responses.map((node) => node.id).sort();
  const expectedResponseIds = [
    "lk_subscription_booking_response_20260804",
    "lk_subscription_booking_options_response_20260804",
  ].sort();
  if (JSON.stringify(responseIds) !== JSON.stringify(expectedResponseIds)
    || JSON.stringify(byId.get(target.finalizeNodeId)?.wires) !== JSON.stringify([
      [target.splitRouterNodeId], ["lk_subscription_booking_response_20260804"],
    ])
    || JSON.stringify(byId.get("lk_subscription_booking_options_20260804")?.wires)
      !== JSON.stringify([["lk_subscription_booking_options_response_20260804"]])) {
    violations.push("execution-contract:http-response");
  }
  const inboundToResponses = flow.flatMap((node) => (node?.wires || []).flatMap((targets) => (
    (Array.isArray(targets) ? targets : []).filter((id) => expectedResponseIds.includes(id))
      .map((id) => `${node.id}:${id}`)
  ))).sort();
  if (JSON.stringify(inboundToResponses) !== JSON.stringify([
    `${target.finalizeNodeId}:lk_subscription_booking_response_20260804`,
    "lk_subscription_booking_options_20260804:lk_subscription_booking_options_response_20260804",
  ].sort())) {
    violations.push("execution-contract:http-response-inbound");
  }
  const reachableFunctionIds = new Set();
  for (const routeSpec of HTTP_ROUTE_SPECS) {
    const route = byId.get(routeSpec.id);
    if (!route) continue;
    const reachable = new Set();
    const queue = [route.id];
    while (queue.length > 0) {
      const id = queue.shift();
      if (reachable.has(id)) continue;
      reachable.add(id);
      const node = byId.get(id);
      for (const next of (Array.isArray(node?.wires) ? node.wires : []).flat()) {
        if (byId.has(next) && !reachable.has(next)) queue.push(next);
      }
    }
    for (const id of reachable) {
      const node = byId.get(id);
      if (node?.type === "function" && !targetFunctionIds.has(id)) {
        violations.push(`${id}:execution-contract:unapproved-function`);
      }
      if (node?.type === "function") reachableFunctionIds.add(id);
      if (["http request", "mongodb4"].includes(node?.type)
        && !FIXED_EXECUTION_NODE_IDS.has(id)) {
        violations.push(`${id}:execution-contract:unapproved-sink`);
      }
      if (node?.type === "catch"
        || (node?.type === "debug" && id !== "lk_subscription_booking_debug_20260804")) {
        violations.push(`${id}:execution-contract:unapproved-observer`);
      }
    }
  }
  return {
    verified: violations.length === 0,
    violations,
    reachableFunctionIds: [...reachableFunctionIds].sort(),
  };
};
