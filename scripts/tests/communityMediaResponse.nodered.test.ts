import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type FlowNode = {
  id?: string;
  type?: string;
  name?: string;
  func?: string;
  outputs?: number;
  wires?: string[][];
};

const flow = JSON.parse(
  fs.readFileSync("node-red/lk_communities_nodes_import.json", "utf8"),
) as FlowNode[];

const responseNodeIds = [
  "community_logo_asset_fn_response_001",
  "community_logo_thumb_fn_response_001",
  "community_logo_legacy_fn_response_001",
  "community_logo_legacy_thumb_fn_response_001",
];

function responseNode(id: string) {
  const node = flow.find((candidate) => candidate.id === id);
  assert.ok(node, `missing response node ${id}`);
  assert.equal(node.type, "function");
  assert.equal(typeof node.func, "string");
  return node;
}

function executeNode(
  node: FlowNode,
  msg: Record<string, unknown>,
  bufferImpl: typeof Buffer = Buffer,
) {
  const execute = new Function("msg", "Buffer", node.func ?? "") as (
    input: Record<string, unknown>,
    runtimeBuffer: typeof Buffer,
  ) => unknown[];
  return execute(msg, bufferImpl);
}

function assertHttpAndDebug(result: unknown[], statusCode: number) {
  assert.equal(result.length, 2);
  assert.ok(result[0]);
  assert.strictEqual(result[0], result[1]);
  assert.equal((result[0] as { statusCode?: number }).statusCode, statusCode);
}

test("community media response errors reach both HTTP response and debug outputs", () => {
  responseNodeIds.forEach((id) => {
    const node = responseNode(id);
    assert.equal(node.outputs, 2);
    assert.equal(node.wires?.length, 2);
    assert.match(node.wires?.[0]?.[0] ?? "", /http_resp/);
    assert.match(node.wires?.[1]?.[0] ?? "", /debug/);
    assert.doesNotMatch(node.func ?? "", /return \[null, errorMsg, errorMsg\]/);
    assert.match(node.func ?? "", /return \[errorMsg, errorMsg\]/);
  });
});

test("missing media documents return an HTTP 404 instead of leaving the request open", () => {
  responseNodeIds.forEach((id) => {
    const result = executeNode(responseNode(id), { payload: [] });
    assertHttpAndDebug(result, 404);
  });
});

test("missing legacy data and missing asset variants return an HTTP 404", () => {
  const legacy = executeNode(responseNode("community_logo_legacy_fn_response_001"), {
    payload: [{ id: "community-without-logo" }],
    _communityLegacyLogo: { variant: "original" },
  });
  assertHttpAndDebug(legacy, 404);

  const asset = executeNode(responseNode("community_logo_asset_fn_response_001"), {
    payload: [{ id: "asset-without-original" }],
    _communityLogoAsset: { variant: "original" },
  });
  assertHttpAndDebug(asset, 404);
});

test("valid legacy and asset images still return binary HTTP 200 responses", () => {
  const encoded = Buffer.from("ok", "utf8").toString("base64");
  const legacy = executeNode(responseNode("community_logo_legacy_fn_response_001"), {
    payload: [{ logoLegacyDataUrl: `data:image/png;base64,${encoded}` }],
    _communityLegacyLogo: { variant: "original" },
  });
  assertHttpAndDebug(legacy, 200);
  assert.ok(Buffer.isBuffer((legacy[0] as { payload?: unknown }).payload));

  const asset = executeNode(responseNode("community_logo_asset_fn_response_001"), {
    payload: [{ original: { mimeType: "image/png", encoding: "base64", body: encoded } }],
    _communityLogoAsset: { variant: "original" },
  });
  assertHttpAndDebug(asset, 200);
  assert.ok(Buffer.isBuffer((asset[0] as { payload?: unknown }).payload));
});

test("decode failures return an HTTP 500 instead of leaving the request open", () => {
  const throwingBuffer = {
    ...Buffer,
    from: () => {
      throw new Error("decode failed");
    },
  } as unknown as typeof Buffer;

  const legacy = executeNode(
    responseNode("community_logo_legacy_fn_response_001"),
    {
      payload: [{ logoLegacyDataUrl: "data:image/png;base64,b2s=" }],
      _communityLegacyLogo: { variant: "original" },
    },
    throwingBuffer,
  );
  assertHttpAndDebug(legacy, 500);

  const asset = executeNode(
    responseNode("community_logo_asset_fn_response_001"),
    {
      payload: [{ original: { mimeType: "image/png", encoding: "base64", body: "b2s=" } }],
      _communityLogoAsset: { variant: "original" },
    },
    throwingBuffer,
  );
  assertHttpAndDebug(asset, 500);
});
