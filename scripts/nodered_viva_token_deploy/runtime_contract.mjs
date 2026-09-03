import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const REVIEWED_LIVE_FLOW_SHA256 =
  "d9ae9ef519f5f1e1bc474ebd7aff955b20721af3467c92f079cf6f68dc26c76a";
export const SERVICE_TOKEN_URL =
  "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";

const LIVE_CONTRACTS = Object.freeze([
  {
    id: "880a87e38e41c38e",
    name: "Get or request Viva token",
    funcSha256: "5310c608ff006d49570dc9b80f1cd2e12c6bd405571e228e46607bbd2bb30235",
    wires: [["1fd1d27e74608f5b"], ["4e8fc55bbbd25474"], ["d51215cddf288d9f"]],
    outputs: 3,
    carriesCredential: true,
  },
  {
    id: "773fd272d093c306",
    name: "Store Viva token (live)",
    funcSha256: "5d67f75f846462635edb79b579cfae115cd7f0352ee99691e5579c34459d5944",
    wires: [["1fd1d27e74608f5b"], ["d51215cddf288d9f"], ["89f8508ef3f6a603"]],
    outputs: 3,
  },
  {
    id: "f3f9a60354d394da",
    name: "Prepare split game payment",
    funcSha256: "a62d72cdaec7bf50f023bf1fcebfb71453df5b02d638cf9793c63a98b112ea8e",
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"]],
    outputs: 3,
    carriesCredential: true,
  },
  {
    id: "e92e68bf3f08a70c",
    name: "Prepare split join payment",
    funcSha256: "bf241c1197090e52a01e5414a81675cc19279fcb26f9231bb15914561401cc17",
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"]],
    outputs: 3,
    carriesCredential: true,
  },
  {
    id: "8f7bd5b482fe9763",
    name: "Route Viva split payment",
    funcSha256: "a311b8ddc6e7752ee87deb278b25ac2ddc8fb9af8b273deea66b07702ac571c8",
    wires: [["ee7ba8cdd68bdf74"], ["802af8a1810db60f"], ["ef42932e1ba864b8"], ["lk_subscription_booking_http_20260804"]],
    outputs: 4,
  },
  {
    id: "bcc3dccf8d64f9bb",
    name: "Route split cleanup action",
    funcSha256: "ef80ddb8930e7e9e9146b799ab8a986a40efd2f7af79e16c5e4124d05b359e26",
    outputs: 4,
    carriesCredential: true,
  },
]);

const CANDIDATE_FUNC_SHA256 = Object.freeze({
  "880a87e38e41c38e": "6e937ed12d7e453040184b10d8f14551bc185191a980e152a9c7b4b58b16338b",
  "773fd272d093c306": "cabb2f7254399bf4901bf379fc52829de97a645df4fc738e9bc851395dc984ad",
  "f3f9a60354d394da": "89e5ef745a785c43f4d1a746060b162b3654af81a075525d3f7c42bc70570a03",
  "e92e68bf3f08a70c": "c05c7af19d3014ca48546871ea742ee347760bdd537cab5e6a67b428ee3d1b3e",
  "8f7bd5b482fe9763": "f9636b7a765faef32a68434bb452bd944d96ccf95bc6646110916bcc359ef2e5",
  "bcc3dccf8d64f9bb": "6aac80dba531ab882589bf87daad48a318106930128c908cf85b8e2680fbe677",
});

const HISTORY_IDS = Object.freeze({
  history: "ddc581fde0073e34",
  feed: "tournament_community_history_feed_20260811",
  catch: "tournament_history_storage_catch_20260816",
  error: "tournament_history_storage_error_20260816",
  response: "tournament_history_storage_response_20260816",
});
const HISTORY_ERROR_FUNC_SHA256 =
  "9cbd19e0ed958739d9da4a7b0118c66d317b1b255b8c525549f25a7513a5514f";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const exactNode = (flow, id) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) throw new Error(`Expected exactly one Node-RED node ${id}`);
  return matches[0];
};

const changedFields = (before, after) => [...new Set([
  ...Object.keys(before || {}),
  ...Object.keys(after || {}),
])].filter((key) => !isDeepStrictEqual(before?.[key], after?.[key])).sort();

const decodeFormValue = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("Reviewed service credential contains invalid form encoding");
  }
};

export function extractPasswordGrantCredential(functionSource) {
  const source = String(functionSource || "");
  const match = source.match(
    /grant_type=password&client_id=([^&"'\\\s]+)&username=([^&"'\\\s]+)&password=([^&"'\\\s;]+)/,
  );
  if (!match) throw new Error("Reviewed function does not contain the expected password grant");
  const credential = {
    clientId: decodeFormValue(match[1]),
    username: decodeFormValue(match[2]),
    password: decodeFormValue(match[3]),
  };
  for (const value of Object.values(credential)) {
    if (!value || /[\0\r\n]/.test(value)) {
      throw new Error("Reviewed service credential contains an unsafe value");
    }
  }
  return credential;
}

export function validateLiveCredentialContract(flow) {
  if (!Array.isArray(flow)) throw new Error("Live Node-RED flow must be an array");
  const credentials = [];
  for (const contract of LIVE_CONTRACTS) {
    const node = exactNode(flow, contract.id);
    if (
      node.type !== "function"
      || node.name !== contract.name
      || Number(node.outputs) !== contract.outputs
      || (contract.wires && !isDeepStrictEqual(node.wires, contract.wires))
      || sha256(Buffer.from(String(node.func || ""), "utf8")) !== contract.funcSha256
    ) throw new Error(`Reviewed live function contract mismatch: ${contract.id}`);
    if (contract.carriesCredential) credentials.push(extractPasswordGrantCredential(node.func));
  }
  if (credentials.length !== 4) throw new Error("Reviewed service credential quorum is incomplete");
  const [reference] = credentials;
  if (!credentials.every((item) => isDeepStrictEqual(item, reference))) {
    throw new Error("Reviewed target functions do not share one service credential");
  }
  return {
    VIVA_SERVICE_USERNAME: reference.username,
    VIVA_SERVICE_PASSWORD: reference.password,
    VIVA_SERVICE_CLIENT_ID: reference.clientId,
    VIVA_SERVICE_TOKEN_URL: SERVICE_TOKEN_URL,
  };
}

export function buildManagedEnvironment(flow) {
  return {
    formatVersion: 1,
    source: "reviewed-live-target-functions",
    ...validateLiveCredentialContract(flow),
  };
}

export function validateManagedEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Viva environment must be an object");
  }
  if (value.formatVersion !== 1 || value.source !== "reviewed-live-target-functions") {
    throw new Error("Managed Viva environment metadata mismatch");
  }
  const result = {};
  for (const key of [
    "VIVA_SERVICE_USERNAME",
    "VIVA_SERVICE_PASSWORD",
    "VIVA_SERVICE_CLIENT_ID",
    "VIVA_SERVICE_TOKEN_URL",
  ]) {
    const normalized = typeof value[key] === "string" ? value[key].trim() : "";
    if (!normalized || /[\0\r\n]/.test(normalized)) {
      throw new Error(`Managed Viva environment field is invalid: ${key}`);
    }
    result[key] = normalized;
  }
  if (result.VIVA_SERVICE_TOKEN_URL !== SERVICE_TOKEN_URL) {
    throw new Error("Managed Viva token URL mismatch");
  }
  return result;
}

export function validateDeploymentCandidate(liveFlow, candidateFlow) {
  if (!Array.isArray(liveFlow) || !Array.isArray(candidateFlow)) {
    throw new Error("Node-RED live and candidate flows must be arrays");
  }
  validateLiveCredentialContract(liveFlow);
  if (candidateFlow.length !== liveFlow.length + 3) {
    throw new Error("Candidate node-count budget mismatch");
  }
  const liveById = new Map(liveFlow.map((node) => [node?.id, node]));
  const candidateById = new Map(candidateFlow.map((node) => [node?.id, node]));
  if (
    liveById.size !== liveFlow.length
    || candidateById.size !== candidateFlow.length
    || liveById.has(undefined)
    || candidateById.has(undefined)
  ) throw new Error("Node-RED flow contains missing or duplicate node IDs");

  const expectedChanges = new Map([
    ["880a87e38e41c38e", ["func"]],
    ["773fd272d093c306", ["func"]],
    ["f3f9a60354d394da", ["func", "outputs", "wires"]],
    ["e92e68bf3f08a70c", ["func", "outputs", "wires"]],
    ["8f7bd5b482fe9763", ["func"]],
    ["bcc3dccf8d64f9bb", ["func"]],
    [HISTORY_IDS.history, ["limit"]],
    [HISTORY_IDS.feed, ["limit"]],
  ]);
  for (const [id, before] of liveById) {
    const after = candidateById.get(id);
    if (!after) throw new Error(`Candidate removed live node ${id}`);
    const fields = changedFields(before, after);
    const expected = expectedChanges.get(id) || [];
    if (!isDeepStrictEqual(fields, expected)) {
      throw new Error(`Candidate change budget mismatch for ${id}: ${fields.join(",")}`);
    }
  }
  for (const [id, expectedHash] of Object.entries(CANDIDATE_FUNC_SHA256)) {
    const node = exactNode(candidateFlow, id);
    if (sha256(Buffer.from(String(node.func || ""), "utf8")) !== expectedHash) {
      throw new Error(`Candidate function hash mismatch: ${id}`);
    }
  }
  for (const id of ["f3f9a60354d394da", "e92e68bf3f08a70c"]) {
    const node = exactNode(candidateFlow, id);
    const liveNode = exactNode(liveFlow, id);
    if (
      Number(node.outputs) !== 4
      || !isDeepStrictEqual(node.wires, [...liveNode.wires, ["8f7bd5b482fe9763"]])
    ) throw new Error(`Candidate cached-token route mismatch: ${id}`);
  }
  if (exactNode(candidateFlow, HISTORY_IDS.history).limit !== "1") {
    throw new Error("Candidate tournament history limit mismatch");
  }
  if (exactNode(candidateFlow, HISTORY_IDS.feed).limit !== "50") {
    throw new Error("Candidate tournament publication limit mismatch");
  }
  const historyTabId = exactNode(liveFlow, HISTORY_IDS.history).z;
  if (typeof historyTabId !== "string" || !historyTabId.trim()) {
    throw new Error("Reviewed tournament history tab ID is invalid");
  }
  const addedContracts = [
    {
      id: HISTORY_IDS.catch,
      type: "catch",
      z: historyTabId,
      name: "Catch tournament history storage errors",
      scope: [HISTORY_IDS.history, HISTORY_IDS.feed],
      uncaught: false,
      x: 1110,
      y: 1620,
      wires: [[HISTORY_IDS.error]],
    },
    {
      id: HISTORY_IDS.error,
      type: "function",
      z: historyTabId,
      name: "Build tournament history storage error",
      func: exactNode(candidateFlow, HISTORY_IDS.error).func,
      outputs: 1,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1430,
      y: 1620,
      wires: [[HISTORY_IDS.response]],
    },
    {
      id: HISTORY_IDS.response,
      type: "http response",
      z: historyTabId,
      name: "Tournament history storage error response",
      statusCode: "",
      headers: {},
      x: 1770,
      y: 1620,
      wires: [],
    },
  ];
  for (const contract of addedContracts) {
    if (liveById.has(contract.id)) throw new Error(`Managed node already exists in live flow: ${contract.id}`);
    const node = exactNode(candidateFlow, contract.id);
    if (!isDeepStrictEqual(node, contract)) {
      throw new Error(`Candidate added-node contract mismatch: ${contract.id}`);
    }
  }
  const errorNode = exactNode(candidateFlow, HISTORY_IDS.error);
  if (sha256(Buffer.from(String(errorNode.func || ""), "utf8")) !== HISTORY_ERROR_FUNC_SHA256) {
    throw new Error("Candidate history error function hash mismatch");
  }
  const knownIds = new Set(candidateFlow.map((node) => node.id));
  for (const node of candidateFlow) {
    for (const row of Array.isArray(node.wires) ? node.wires : []) {
      for (const targetId of Array.isArray(row) ? row : []) {
        if (!knownIds.has(targetId)) throw new Error(`Candidate contains broken wire ${node.id}->${targetId}`);
      }
    }
  }
  const liveRoutes = liveFlow.filter((node) => node?.type === "http in");
  const candidateRoutes = candidateFlow.filter((node) => node?.type === "http in");
  if (!isDeepStrictEqual(liveRoutes, candidateRoutes)) throw new Error("Candidate changed HTTP routes");
  return {
    liveNodeCount: liveFlow.length,
    candidateNodeCount: candidateFlow.length,
    changedExistingNodeCount: expectedChanges.size,
    addedNodeCount: 3,
    httpRouteCount: candidateRoutes.length,
  };
}
