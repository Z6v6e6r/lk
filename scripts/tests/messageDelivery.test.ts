import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { messageSendError, MESSAGE_DELIVERY_UNCONFIRMED } from "../../src/utils/messageDelivery.ts";

// Execute the production functions with a transport fixture. A simulated lost response
// increments accepted writes before returning failure, so a replay is observable.
function functions(file: string, names: string[], bindings: Record<string, unknown>) {
  const code = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ""));
  assert.equal(selected.length, names.length);
  const js = ts.transpileModule(selected.map((node) => node.getText(ast).replace(/^export /, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), js + `\nreturn { ${names.join(",")} };`)(...Object.values(bindings));
}
const statuses = [null, 401, 403, 404, 405, 429, 500, 502, 503, 504];
const failure = (status: number | null) => ({ data: null, status,
  error: { status, message: "synthetic refusal", raw: { code: "synthetic" } } });
const candidates = ["https://primary.invalid/lk", "https://primary.invalid/api", "https://reserve.invalid/lk"];
const shared = { messageSendError, MESSAGE_DELIVERY_UNCONFIRMED };
function transport(result: any) {
  const calls: any[] = [];
  let acceptedWrites = 0;
  return { calls, get acceptedWrites() { return acceptedWrites; }, request: async (path: string, options: any) => {
    // Model the real request retry option, rather than treating it as inert metadata.
    for (let i = 0; i <= (options.retries || 0); i++) {
      calls.push({ path, options });
      if (options.method === "POST") acceptedWrites++;
    }
    return result;
  } };
}
function support(request: unknown) {
  return functions("src/utils/apiClient.ts", ["requestSupportWithFallback"], {
    ...shared, request, buildSupportEndpointCandidates: () => candidates,
  }).requestSupportWithFallback;
}
function community(request: unknown) {
  return functions("src/utils/communityApi.ts", ["requestCommunityMutation", "apiCreateCommunityChatMessage"], {
    ...shared, request, readAuthToken: () => "synthetic-token", buildCommunityMutationBaseUrls: () => candidates,
    shouldRetryCommunityMutation: (result: any) => result.error && (result.status === null || result.status >= 500 || [404,405].includes(result.status)),
    communityListReads: { clear() {} }, buildMemberPayload: (x: unknown) => x,
    errorResult: (status: unknown, message: string, data: unknown) => ({ status, data, error: { status, message } }),
    isRecord: (x: any) => x !== null && typeof x === "object",
    normalizeCommunityChatMessage: (x: any) => x?.id ? x : null,
  });
}
function game(request: unknown) {
  return functions("src/utils/apiClient.ts", ["apiSendPadelGameChatMessage"], {
    ...shared, request, normalizePhoneForChat: (x: string) => x, getServ2Origin: () => "https://primary.invalid",
    isRecord: (x: any) => x !== null && typeof x === "object",
    normalizePadelGameChatMessage: (x: any) => x?.id ? x : null,
  }).apiSendPadelGameChatMessage;
}
for (const status of statuses) {
  test(`all three chat sends make one POST on ${status ?? "lost response"}`, async () => {
    const result = failure(status);
    for (const kind of ["support", "community", "game"]) {
      const t = transport(result);
      const response = kind === "support" ? await support(t.request)("/support/dialogs/events", { method: "POST", retries: 3, body: "synthetic" })
        : kind === "community" ? await community(t.request).apiCreateCommunityChatMessage("synthetic", { text: "hello", member: {} })
        : await game(t.request)({ gameId: "synthetic", senderPhone: "synthetic", text: "hello" });
      assert.equal(t.calls.length, 1, kind);
      assert.equal(t.acceptedWrites, 1, kind);
      assert.equal(t.calls[0].options.retries, 0, kind);
      assert.equal(response.status, status, kind);
      assert.equal(response.error.message, status === null || status >= 500 ? MESSAGE_DELIVERY_UNCONFIRMED : result.error.message, kind);
      assert.deepEqual(response.error.raw, result.error.raw);
    }
  });
}
test("support reads retain fallback and successful responses are returned unchanged", async () => {
  let calls = 0;
  const success = { data: { found: true }, error: null, status: 200 };
  const read = support(async () => ++calls === 1 ? failure(503) : success);
  assert.equal(await read("/support/dialogs", { method: "GET" }), success);
  assert.equal(calls, 2);
  calls = 0;
  const write = support(async () => { calls++; return success; });
  assert.equal(await write("/support/dialogs/events", { method: "POST" }), success);
  assert.equal(calls, 1);
});
test("game and community preserve the echoed message and do not retry malformed success", async () => {
  for (const kind of ["game", "community"]) {
    for (const data of [{ id: "synthetic-message", text: "hello" }, {}]) {
      const t = transport({ data, error: null, status: 200 });
      const response = kind === "game" ? await game(t.request)({ gameId: "synthetic", senderPhone: "synthetic", text: "hello" })
        : await community(t.request).apiCreateCommunityChatMessage("synthetic", { text: "hello", member: {} });
      assert.equal(t.calls.length, 1);
      if ("id" in data) { assert.equal(response.data, data); assert.equal(response.error, null); }
      else assert.equal(response.error.message, MESSAGE_DELIVERY_UNCONFIRMED);
    }
  }
});
test("other community mutations keep existing fallback and auth behavior", async () => {
  let calls = 0;
  const success = { data: {}, error: null, status: 200 };
  const { requestCommunityMutation } = community(async (_path: unknown, options: any) => {
    assert.equal(options.auth, true);
    calls++;
    return calls === 1 ? failure(503) : success;
  });
  assert.equal(await requestCommunityMutation("/unrelated", { method: "PATCH" }), success);
  assert.equal(calls, 2);
});
test("ambiguity wording retains status and diagnostic object without mutating input", () => {
  const original = failure(503).error;
  const result = messageSendError(original, 503);
  assert.equal(result.raw, original.raw);
  assert.equal(result.status, 503);
  assert.equal(original.message, "synthetic refusal");
  assert.equal(messageSendError(original, 401), original);
});
