"use strict";

const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");

const MAX_BODY_BYTES = 16384;
const SECURITY_HEADERS = Object.freeze([
  "content-type", "x-padlhub-client-id", "x-padlhub-audience", "x-padlhub-key-id",
  "x-padlhub-timestamp", "x-padlhub-nonce", "idempotency-key", "x-correlation-id",
  "x-padlhub-signature",
]);
const fail = (code) => { throw new Error(code); };
const ERROR_CODES = new Set([
  "RAW_BODY_SIZE", "RAW_JSON_INVALID", "RAW_JSON_COMPLEXITY", "RAW_JSON_DUPLICATE_KEY", "RAW_JSON_OBJECT_REQUIRED",
  "RAW_ROUTE_INVALID", "RAW_HEADERS_INVALID", "RAW_HEADERS_SIZE", "RAW_HEADER_DUPLICATE", "RAW_HOST_INVALID",
  "RAW_SECURITY_HEADER_INVALID", "RAW_CONTENT_TYPE_INVALID", "RAW_FRAMING_INVALID", "RAW_GUARD_ORDER_INVALID",
  "RAW_AUDIT_UNAVAILABLE", "RAW_BODY_TIMEOUT", "RAW_BODY_ABORTED", "RAW_BODY_IO_ERROR", "RAW_RESPONSE_CLOSED",
  "RAW_DELETE_BODY_INVALID",
]);

// Scan decoded object keys before JSON.parse can discard duplicates. No stream
// replay, reviver, object assignment or canonical-wire-JSON requirement.
function parsePartnerRawJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BODY_BYTES) fail("RAW_BODY_SIZE");
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("RAW_JSON_INVALID"); }
  let pos = 0;
  let tokens = 0;
  const invalid = () => fail("RAW_JSON_INVALID");
  const space = () => { while (pos < source.length && /[ \t\r\n]/.test(source[pos])) pos++; };
  const string = () => {
    if (source[pos++] !== '"') invalid();
    const start = pos - 1;
    while (pos < source.length) {
      const ch = source[pos++];
      if (ch === '"') {
        try { return JSON.parse(source.slice(start, pos)); } catch { invalid(); }
      }
      if (ch.charCodeAt(0) < 32) invalid();
      if (ch === "\\") {
        const escape = source[pos++];
        if (escape === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(source.slice(pos, pos + 4))) invalid();
          pos += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) invalid();
      }
    }
    invalid();
  };
  const value = (depth) => {
    if (depth > 32 || ++tokens > 4096) fail("RAW_JSON_COMPLEXITY");
    space();
    const ch = source[pos];
    if (ch === '"') { string(); return; }
    if (ch === "{" || ch === "[") {
      pos++;
      const object = ch === "{";
      const close = object ? "}" : "]";
      const keys = new Set();
      space();
      if (source[pos] === close) { pos++; return; }
      for (;;) {
        space();
        if (object) {
          const key = string();
          if (keys.has(key)) fail("RAW_JSON_DUPLICATE_KEY");
          keys.add(key);
          space();
          if (source[pos++] !== ":") invalid();
        }
        value(depth + 1);
        space();
        if (source[pos] === close) { pos++; return; }
        if (source[pos++] !== ",") invalid();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(pos));
    if (!match) invalid();
    pos += match[0].length;
  };
  value(0);
  space();
  if (pos !== source.length) invalid();
  let parsed;
  try { parsed = JSON.parse(source); } catch { invalid(); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") fail("RAW_JSON_OBJECT_REQUIRED");
  return parsed;
}

function validateRawRequest(req, expectedHost) {
  const target = req.originalUrl;
  if (typeof target !== "string" || target !== req.url || Buffer.byteLength(target) > 2048) fail("RAW_ROUTE_INVALID");
  const id = "[A-Za-z0-9_-]{1,160}";
  const route = req.method === "POST" ? `/lk/integrations/v1/open-games/${id}/members`
    : req.method === "DELETE" ? `/lk/integrations/v1/open-games/${id}/members/${id}`
      : req.method === "GET" ? `/lk/integrations/v1/operations/${id}` : null;
  if (!route || !new RegExp(`^${route}$`).test(target)) fail("RAW_ROUTE_INVALID");
  if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2 || req.rawHeaders.length > 200) fail("RAW_HEADERS_INVALID");
  const headers = new Map();
  let size = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const val = req.rawHeaders[i + 1];
    if (typeof name !== "string" || typeof val !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || /[^\x20-\x7e]/.test(val)) fail("RAW_HEADERS_INVALID");
    size += Buffer.byteLength(name) + Buffer.byteLength(val) + 4;
    if (size > 16384) fail("RAW_HEADERS_SIZE");
    const key = name.toLowerCase();
    // This dedicated API has no legitimate multi-valued headers. Rejecting all
    // multiplicity also avoids future security-header allowlist omissions.
    if (headers.has(key)) fail("RAW_HEADER_DUPLICATE");
    headers.set(key, val);
  }
  if (headers.get("host") !== expectedHost) fail("RAW_HOST_INVALID");
  for (const name of SECURITY_HEADERS) {
    if (name === "content-type" && req.method === "GET" && !headers.has(name)) continue;
    if (!headers.has(name) || !/^[\x21-\x7e]+$/.test(headers.get(name)) || headers.get(name).includes(",")) fail("RAW_SECURITY_HEADER_INVALID");
  }
  if (headers.has("content-type") && headers.get("content-type") !== "application/json") fail("RAW_CONTENT_TYPE_INVALID");
  for (const name of ["transfer-encoding", "content-encoding", "trailer", "expect", "upgrade", "proxy-connection"]) {
    if (headers.has(name)) fail("RAW_FRAMING_INVALID");
  }
  if (headers.has("connection") && !/^(close|keep-alive)$/i.test(headers.get("connection"))) fail("RAW_FRAMING_INVALID");
  const length = headers.get("content-length");
  if (req.method === "GET") {
    if (length !== undefined && length !== "0") fail("RAW_FRAMING_INVALID");
    return 0;
  }
  if (!length || !/^[1-9][0-9]{0,4}$/.test(length)) fail("RAW_FRAMING_INVALID");
  if (Number(length) > MAX_BODY_BYTES) fail("RAW_BODY_SIZE");
  return Number(length);
}

function createPartnerRawRequestGuard({ expectedHost, audit, bodyTimeoutMs = 5000 } = {}) {
  if (typeof expectedHost !== "string" || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(expectedHost)
    || typeof audit !== "function" || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 5000) {
    fail("RAW_GUARD_CONFIGURATION_INVALID");
  }
  return function partnerRawRequestGuard(req, res, next) {
    const requestId = randomUUID();
    let settled = false;
    let chunks = [];
    let received = 0;
    let timer;
    let expected = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAbort);
      req.removeListener("error", onError);
      res.removeListener("close", onClose);
      chunks = [];
    };
    const record = (code) => {
      try {
        // A synchronous trusted sink must confirm persistence/acceptance. Never
        // include raw data, paths, client IDs, addresses or caller correlation IDs.
        const accepted = audit(Object.freeze({ stage: "RAW_REQUEST_GUARD", code, requestId }));
        if (accepted && typeof accepted.then === "function") Promise.resolve(accepted).catch(() => {});
        return accepted === true;
      } catch { return false; }
    };
    const reject = (code) => {
      if (settled) return;
      if (!ERROR_CODES.has(code)) code = "RAW_GUARD_INTERNAL_ERROR";
      settled = true;
      cleanup();
      req.pause();
      const recorded = record(code);
      if (!recorded) code = "RAW_AUDIT_UNAVAILABLE";
      if (res.destroyed || res.headersSent) { req.destroy(); return; }
      res.statusCode = !recorded || code === "RAW_AUDIT_UNAVAILABLE" ? 503
        : code === "RAW_BODY_TIMEOUT" ? 408 : code === "RAW_BODY_SIZE" ? 413 : 400;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "close");
      // Do not drain/reuse a connection whose unread bytes may be ambiguous.
      res.end(JSON.stringify({ error: code, requestId }), () => req.destroy());
    };
    function onAbort() { reject("RAW_BODY_ABORTED"); }
    function onError() { reject("RAW_BODY_IO_ERROR"); }
    function onClose() { reject("RAW_RESPONSE_CLOSED"); }
    function onData(chunk) {
      if (!Buffer.isBuffer(chunk)) { reject("RAW_GUARD_ORDER_INVALID"); return; }
      received += chunk.length;
      if (received > MAX_BODY_BYTES || received > expected) { reject("RAW_BODY_SIZE"); return; }
      chunks.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      if (!req.complete || received !== expected || Object.keys(req.trailers || {}).length) { reject("RAW_FRAMING_INVALID"); return; }
      let body;
      try {
        body = req.method === "GET" ? {} : parsePartnerRawJson(Buffer.concat(chunks, received));
        if (req.method === "DELETE" && Object.keys(body).length) fail("RAW_DELETE_BODY_INVALID");
      } catch (error) { reject(error.message); return; }
      if (!record("RAW_ACCEPTED")) { reject("RAW_AUDIT_UNAVAILABLE"); return; }
      settled = true;
      cleanup();
      req.body = body;
      req._body = true; // body-parser 1.x (locked Node-RED 5.0.6)
      req.skipRawBodyParser = true;
      next();
    }
    try {
      if (req.body !== undefined || req._body || req.skipRawBodyParser || req.readableEnded || req.readableDidRead
        || req.readableFlowing !== null || req.destroyed || req.readableEncoding !== null) fail("RAW_GUARD_ORDER_INVALID");
      expected = validateRawRequest(req, expectedHost);
    } catch (error) { reject(error.message); return; }
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAbort);
    req.once("error", onError);
    res.once("close", onClose);
    timer = setTimeout(() => reject("RAW_BODY_TIMEOUT"), bodyTimeoutMs);
  };
}

module.exports = { createPartnerRawRequestGuard, parsePartnerRawJson, SECURITY_HEADERS, MAX_BODY_BYTES };
