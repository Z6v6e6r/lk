#!/usr/bin/env node
// Reference signer for the PadlHub Partner Game Membership API (PADLHUB-PARTNER-GAME-V2).
//
// It is intentionally self-contained: only Node.js builtins, no dependencies, no network.
// Use it to produce the proof headers for a real request, or as a readable specification
// of the canonical JSON and HMAC steps your client must reproduce.
//
// Usage:
//   node sign.mjs --client-id <id> --audience <aud> --key-id <kid> --secret <value> \
//     [--secret-format base64url|utf8] \
//     --method POST --path /lk/integrations/v1/open-games/<gameId>/members \
//     [--body <file|@inline-json>] [--idempotency-key <uuid>] [--correlation-id <uuid>] \
//     [--timestamp <unix-seconds>] [--nonce <base64url>] [--json]
//
// Exit code 0 on success, 1 with a closed error code on misuse.

import fs from "node:fs";
import crypto from "node:crypto";

const VERSION = "PADLHUB-PARTNER-GAME-V2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

function fail(code) { process.stderr.write(`${code}\n`); process.exit(1); }

function parseArgs(argv) {
  const allowed = new Set([
    "client-id", "audience", "key-id", "secret", "method", "path",
    "body", "idempotency-key", "correlation-id", "timestamp", "nonce", "json", "secret-format",
  ]);
  const out = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail("UNKNOWN_ARGUMENT");
    const name = token.slice(2);
    if (!allowed.has(name)) fail("UNKNOWN_ARGUMENT");
    if (name === "json") { out.json = true; continue; }
    const value = argv[++index];
    if (typeof value !== "string") fail("MISSING_ARGUMENT_VALUE");
    out[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}

// Canonical JSON dialect of the contract: recursive object key sort by JS UTF-16 code
// units, arrays keep order, strings escaped by JSON.stringify without normalization,
// numbers must be safe integers and -0 becomes 0. This is not RFC 8785.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("NON_INTEGER_NUMBER");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("UNSUPPORTED_JSON_VALUE");
  return "";
}

function readBody(spec) {
  if (spec === undefined) return "";
  if (spec.startsWith("@")) return spec.slice(1);
  if (!fs.existsSync(spec)) fail("BODY_FILE_NOT_FOUND");
  return fs.readFileSync(spec, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["clientId", "audience", "keyId", "secret", "method", "path"]) {
    if (!args[required]) fail("MISSING_ARGUMENT");
  }
  const method = args.method.toUpperCase();
  if (!/^(GET|POST|DELETE)$/.test(method)) fail("UNSUPPORTED_METHOD");
  if (!TOKEN.test(args.clientId) || !TOKEN.test(args.keyId)) fail("INVALID_IDENTITY");
  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/.test(args.audience)) fail("INVALID_AUDIENCE");
  if (args.path.includes("?") || args.path.includes("#")) fail("QUERY_OR_FRAGMENT_FORBIDDEN");

  const rawBody = readBody(args.body);
  let parsed = {};
  if (rawBody.trim() !== "") {
    try { parsed = JSON.parse(rawBody); } catch { fail("BODY_NOT_JSON"); }
  } else if (method !== "GET") {
    fail("MISSING_BODY");
  }
  const canonicalBody = canonicalJson(parsed);
  const bodySha256 = crypto.createHash("sha256").update(Buffer.from(canonicalBody, "utf8")).digest("hex");

  const timestamp = args.timestamp || String(Math.floor(Date.now() / 1000));
  if (!/^\d{10}$/.test(timestamp)) fail("INVALID_TIMESTAMP");
  const nonce = args.nonce || crypto.randomBytes(24).toString("base64url");
  if (!NONCE.test(nonce)) fail("INVALID_NONCE");
  const idempotencyKey = args.idempotencyKey || crypto.randomUUID();
  const correlationId = args.correlationId || crypto.randomUUID();
  if (!UUID.test(idempotencyKey)) fail("INVALID_IDEMPOTENCY_KEY");
  if (!UUID.test(correlationId)) fail("INVALID_CORRELATION_ID");

  const signatureInput = [
    VERSION, args.audience, args.clientId, args.keyId, timestamp, nonce,
    method, args.path, bodySha256, idempotencyKey, correlationId,
  ].join("\n");
  const secretFormat = args.secretFormat || "base64url";
  if (!["base64url", "utf8"].includes(secretFormat)) fail("INVALID_SECRET_FORMAT");
  const secret = secretFormat === "utf8" ? Buffer.from(args.secret, "utf8") : Buffer.from(args.secret, "base64url");
  if (secret.length < 32) fail("SECRET_TOO_SHORT");
  const signature = `v2=${crypto.createHmac("sha256", secret).update(Buffer.from(signatureInput, "utf8")).digest("base64url")}`;

  const headers = {
    "X-PadlHub-Client-Id": args.clientId,
    "X-PadlHub-Audience": args.audience,
    "X-PadlHub-Key-Id": args.keyId,
    "X-PadlHub-Timestamp": timestamp,
    "X-PadlHub-Nonce": nonce,
    "X-PadlHub-Signature": signature,
    "Idempotency-Key": idempotencyKey,
    "X-Correlation-ID": correlationId,
  };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ headers, canonicalBody, signatureInput, bodySha256 }, null, 2)}\n`);
    return;
  }
  for (const [name, value] of Object.entries(headers)) process.stdout.write(`-H '${name}: ${value}' \\\n`);
  if (method !== "GET") process.stdout.write(`--data '${canonicalBody}'\n`);
}

main();
