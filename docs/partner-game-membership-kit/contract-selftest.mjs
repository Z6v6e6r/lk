// Public, offline contract example. Not a production SDK or a request sender.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PUBLIC_TEST_KEY = "public-test-vector-key-32-bytes!!";
const VERSION = "PADLHUB-PARTNER-GAME-V2";
const INPUT_KEYS = [
  "method", "path", "body", "clientId", "audience", "keyId", "timestamp",
  "nonce", "idempotencyKey", "correlationId",
];
const VECTOR_IDS = ["POST_BASE", "POST_RETRY", "DELETE_OWNED", "GET_OPERATION", "POST_UNICODE"];
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const fail = () => { throw new Error("OFFLINE_CONTRACT_INVALID"); };
const plain = (value) => value !== null && typeof value === "object"
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => {
  if (!plain(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) fail();
};

// Independent implementation of the published JSON signing dialect, not RFC 8785.
// The depth bound is only a safety limit for this fixed offline example.
export function canonicalContractJson(value, depth = 0) {
  if (depth > 32) fail();
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail();
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalContractJson(item, depth + 1)).join(",")}]`;
  if (!plain(value)) fail();
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalContractJson(value[key], depth + 1)}`).join(",")}}`;
}

// Intentionally accepts only the public demo identity/game and the public test key.
// It does not read environment variables, load credentials or send HTTP requests.
export function computePublicVector(input) {
  exactKeys(input, INPUT_KEYS);
  for (const field of INPUT_KEYS.filter((key) => key !== "body")) {
    if (typeof input[field] !== "string" || /\s/u.test(input[field])
      || [...input[field]].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail();
  }
  if (input.clientId !== "partner-test" || input.audience !== "padlhub-partner-game-test"
    || input.keyId !== "key-2026-09") fail();
  if (typeof input.timestamp !== "string" || !/^\d{10}$/.test(input.timestamp)
    || typeof input.nonce !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(input.nonce)) fail();
  for (const field of ["idempotencyKey", "correlationId"]) {
    if (typeof input[field] !== "string" || !new RegExp(`^${UUID}$`).test(input[field])) fail();
  }
  const route = input.method === "POST" ? "/lk/integrations/v1/open-games/game-001/members"
    : input.method === "DELETE" ? `/lk/integrations/v1/open-games/game-001/members/${UUID}`
      : input.method === "GET" ? `/lk/integrations/v1/operations/${UUID}` : null;
  if (!route || typeof input.path !== "string" || !new RegExp(`^${route}$`).test(input.path)) fail();
  if (input.method === "POST") {
    exactKeys(input.body, ["externalPlayerId", "displayName", "payment"]);
    exactKeys(input.body.payment, ["reference", "paidAt", "amountMinor", "currency"]);
  } else exactKeys(input.body, []);
  const canonicalBody = canonicalContractJson(input.body);
  const bodySha256 = createHash("sha256").update(canonicalBody, "utf8").digest("hex");
  const signatureInput = [VERSION, input.audience, input.clientId, input.keyId,
    input.timestamp, input.nonce, input.method, input.path, bodySha256,
    input.idempotencyKey, input.correlationId].join("\n");
  const signature = `v2=${createHmac("sha256", Buffer.from(PUBLIC_TEST_KEY, "utf8"))
    .update(signatureInput, "utf8").digest("base64url")}`;
  const wireBody = input.method === "GET" ? "" : canonicalBody;
  return { canonicalBody, bodySha256, signatureInput, signature,
    wireBody, wireBodyBytes: Buffer.byteLength(wireBody, "utf8") };
}

export function verifyPublicContractVectors(document) {
  exactKeys(document, ["format", "productionUsable", "publicTestKeyUtf8", "vectors"]);
  if (document.format !== "PADLHUB_OFFLINE_CONTRACT_V1" || document.productionUsable !== false
    || document.publicTestKeyUtf8 !== PUBLIC_TEST_KEY || !Array.isArray(document.vectors)
    || document.vectors.length !== VECTOR_IDS.length) fail();
  document.vectors.forEach((vector, index) => {
    exactKeys(vector, ["id", "input", "expected"]);
    if (vector.id !== VECTOR_IDS[index]) fail();
    const actual = computePublicVector(vector.input);
    // Compare with frozen values, never regenerate expected values during self-test.
    assert.deepEqual(actual, vector.expected);
  });
  const [base, retry] = document.vectors;
  for (const key of ["method", "path", "body", "idempotencyKey"]) {
    assert.deepEqual(retry.input[key], base.input[key]);
  }
  for (const key of ["timestamp", "nonce", "correlationId"]) {
    assert.notEqual(retry.input[key], base.input[key]);
  }
  return document.vectors.length;
}

export function loadPublicContractVectors() {
  const fixture = new URL("./vectors.json", import.meta.url);
  const info = lstatSync(fixture);
  if (!info.isFile() || info.size > 65536) fail();
  return JSON.parse(readFileSync(fixture, "utf8"));
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--self-test") fail();
    const count = verifyPublicContractVectors(loadPublicContractVectors());
    process.stdout.write(`OFFLINE_CONTRACT_VECTORS_PASS vectors=${count} network=NOT_USED live_security=NOT_TESTED\n`);
  } catch {
    // No arguments, file contents, signature inputs or exception details in logs.
    process.stderr.write("OFFLINE_CONTRACT_SELFTEST_FAILED\n");
    process.exitCode = 1;
  }
}
