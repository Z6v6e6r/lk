#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REDACTED = "[REDACTED]";
const NON_JSON_REDACTED = "[NON_JSON_BODY_REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

const RETAINED_HEADER_NAMES = new Set([
  "accept",
  "content-type",
  "origin",
  "authorization",
  "x-request-id",
  "x-correlation-id",
  "idempotency-key",
  "location",
  "retry-after",
]);

const SAFE_QUERY_VALUE_NAMES = new Set([
  "date",
  "datefrom",
  "dateto",
  "size",
  "page",
  "limit",
  "offset",
  "sort",
  "includecanceled",
  "includecompleted",
  "showcancelled",
]);

const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:authorization|password|secret|token|cookie|session|login|username|phone|mobile|telephone|whatsapp|email|name|title|first_name|last_name|full_name|display_name|client_name|address|comment|description|bio|birth_date|birthday|date_of_birth|dob|passport|document|snils|inn|card|pan|cvc|cvv|otp|kkm|fiscal|receipt)(?:$|_)/i;
const URL_KEY_PATTERN = /(?:url|uri|href|link)$/i;

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?7|8)[\s()-]*\d{3}[\s()-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g;
const PAN_CANDIDATE_PATTERN = /(?<![\d.])(?:\d[ -]*?){13,19}(?![\d.])/g;
const MONGO_URI_PATTERN = /mongodb(?:\+srv)?:\/\/[^\s"']+/gi;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const isLikelyPan = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
};

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeKey = (value) => String(value || "")
  .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
  .replace(/[^a-zA-Z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "")
  .toLowerCase();

const isSensitiveKey = (value) => SENSITIVE_KEY_PATTERN.test(normalizeKey(value));

const isIdKey = (value) => {
  const normalized = normalizeKey(value);
  return /^(?:id|ids|uuid|uuids)$/.test(normalized)
    || /_(?:id|ids|uuid|uuids)$/.test(normalized);
};

const normalizeHost = (value) => String(value || "").trim().toLowerCase();
const sanitizeMimeType = (value) => String(value || "application/octet-stream")
  .split(";", 1)[0]
  .trim()
  .toLowerCase();

const hostAllowed = (hostname, allowedHosts) => {
  const normalized = normalizeHost(hostname);
  return allowedHosts.some((allowed) => (
    normalized === allowed || normalized.endsWith(`.${allowed}`)
  ));
};

const normalizePathPrefix = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith("/")) {
    throw new Error("Path prefix must start with /");
  }
  if (/[?#]/.test(normalized)) {
    throw new Error("Path prefix must not contain query or fragment");
  }
  const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  const segments = withoutTrailingSlash.split("/");
  if (segments[1] === "end-user"
    && segments[2] === "api"
    && /^v[12]$/i.test(segments[3] || "")
    && segments[4] !== "{tenant}") {
    throw new Error("End-user path prefix must use the {tenant} placeholder");
  }
  return withoutTrailingSlash;
};

const filterPathTemplate = (rawPath) => {
  const segments = String(rawPath || "").split("/");
  return segments.map((segment, index) => {
    if (!segment) return segment;
    const previous = segments[index - 1] || "";
    const tenantSegment = index >= 4
      && segments[index - 3] === "end-user"
      && segments[index - 2] === "api"
      && /^v[12]$/i.test(previous);
    if (tenantSegment) return "{tenant}";
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return "{id}";
    if (/^(?:pay|viva|community)_[a-z0-9_:-]{8,}$/i.test(segment)) return "{id}";
    if (/^\d{5,}$/.test(segment)) return "{id}";
    return segment;
  }).join("/");
};

const pathAllowed = (pathname, allowedPathPrefixes) => {
  const template = filterPathTemplate(pathname);
  return allowedPathPrefixes.some((prefix) => (
    template === prefix || template.startsWith(`${prefix}/`)
  ));
};

const createAliasStore = () => {
  const aliases = new Map();
  const counters = new Map();

  const normalizeKind = (value) => {
    const normalized = String(value || "id")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return normalized || "id";
  };

  return (kind, value) => {
    if (value === null || value === undefined || value === "") return value;
    const normalizedKind = normalizeKind(kind);
    const raw = String(value);
    const mapKey = raw;
    if (aliases.has(mapKey)) return aliases.get(mapKey);
    const next = (counters.get(normalizedKind) || 0) + 1;
    counters.set(normalizedKind, next);
    const alias = `${normalizedKind}-${String(next).padStart(3, "0")}`;
    aliases.set(mapKey, alias);
    return alias;
  };
};

const sanitizeString = (value, alias) => {
  let result = String(value);
  result = result.replace(JWT_PATTERN, REDACTED);
  result = result.replace(MONGO_URI_PATTERN, REDACTED);
  result = result.replace(EMAIL_PATTERN, (match) => alias("email", match.toLowerCase()));
  result = result.replace(PHONE_PATTERN, (match) => alias("phone", match.replace(/\D/g, "")));
  result = result.replace(PAN_CANDIDATE_PATTERN, (match) => (
    isLikelyPan(match) ? REDACTED : match
  ));
  result = result.replace(UUID_PATTERN, (match) => alias("uuid", match.toLowerCase()));
  return result;
};

const sanitizeUrl = (value, alias, { preserveSafeQueryValues = true } = {}) => {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return REDACTED;
  }

  const segments = parsed.pathname.split("/");
  const sanitizedSegments = segments.map((segment, index) => {
    if (!segment) return segment;
    const decoded = (() => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })();
    const previous = segments[index - 1] || "";
    const tenantSegment = index >= 4
      && segments[index - 3] === "end-user"
      && segments[index - 2] === "api"
      && /^v[12]$/i.test(previous);
    if (tenantSegment) return alias("tenant", decoded);
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)) return alias("uuid", decoded.toLowerCase());
    if (/^(?:pay|viva|community)_[a-z0-9_:-]{8,}$/i.test(decoded)) return alias("external-id", decoded);
    if (/^\d{5,}$/.test(decoded)) return alias("numeric-id", decoded);
    if (/^[A-Za-z0-9_-]{24,}$/.test(decoded)) return alias("path-id", decoded);
    return encodeURIComponent(sanitizeString(decoded, alias));
  });

  parsed.pathname = sanitizedSegments.join("/");
  const sanitizedQuery = new URLSearchParams();
  for (const [key, rawValue] of parsed.searchParams.entries()) {
    const normalizedKey = key.toLowerCase();
    const valueToStore = preserveSafeQueryValues && SAFE_QUERY_VALUE_NAMES.has(normalizedKey)
      ? sanitizeString(rawValue, alias)
      : alias(key, rawValue);
    sanitizedQuery.append(key, String(valueToStore));
  }
  parsed.search = sanitizedQuery.toString();
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
};

const sanitizeStructuredValue = (value, alias, key = "value") => {
  if (isSensitiveKey(key)) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredValue(item, alias, key));
  }
  if (isObject(value)) {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeStructuredValue(childValue, alias, childKey);
    }
    return result;
  }
  if (value === null || value === undefined) return value;

  if (isIdKey(key)) {
    if (Array.isArray(value)) return value.map((item) => alias(key, item));
    return alias(key, value);
  }
  if (URL_KEY_PATTERN.test(key) && typeof value === "string") return sanitizeUrl(value, alias);
  if (typeof value === "string") return sanitizeString(value, alias);
  if (typeof value === "number" && Number.isInteger(value) && isLikelyPan(Math.abs(value))) {
    return REDACTED;
  }
  return value;
};

const sanitizeHeaders = (headers, alias) => {
  if (!Array.isArray(headers)) return [];
  const result = [];
  for (const header of headers) {
    const name = String(header?.name || "").trim();
    const normalizedName = name.toLowerCase();
    if (!name || !RETAINED_HEADER_NAMES.has(normalizedName)) continue;
    let value = String(header?.value || "");
    if (SENSITIVE_HEADER_NAMES.has(normalizedName)) {
      value = REDACTED;
    } else if (normalizedName === "location") {
      value = sanitizeUrl(value, alias);
    } else if (["x-request-id", "x-correlation-id", "idempotency-key"].includes(normalizedName)) {
      value = alias(normalizedName, value);
    } else {
      value = sanitizeString(value, alias);
    }
    result.push({ name, value });
  }
  return result;
};

const sanitizeCookies = (cookies) => {
  if (!Array.isArray(cookies)) return [];
  return cookies.map(() => ({
    name: REDACTED,
    value: REDACTED,
  }));
};

const sanitizeBodyText = (text, alias) => {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(sanitizeStructuredValue(parsed, alias), null, 2);
  } catch {
    return NON_JSON_REDACTED;
  }
};

const sanitizePostData = (postData, alias) => {
  if (!isObject(postData)) return undefined;
  const result = {
    mimeType: sanitizeMimeType(postData.mimeType),
  };
  if (Array.isArray(postData.params)) {
    result.params = postData.params.map((param) => ({
      name: sanitizeString(param?.name || "", alias),
      value: isSensitiveKey(param?.name)
        ? REDACTED
        : sanitizeString(param?.value || "", alias),
    }));
  }
  if (typeof postData.text === "string") {
    result.text = sanitizeBodyText(postData.text, alias);
  }
  return result;
};

const sanitizeContent = (content, alias) => {
  if (!isObject(content)) return { size: 0, mimeType: "application/octet-stream" };
  const result = {
    size: Number.isFinite(content.size) ? content.size : 0,
    mimeType: sanitizeMimeType(content.mimeType),
  };
  if (typeof content.text === "string") {
    result.text = content.encoding
      ? NON_JSON_REDACTED
      : sanitizeBodyText(content.text, alias);
  }
  return result;
};

const sanitizeRequest = (request, alias) => {
  const sanitizedUrl = sanitizeUrl(request?.url || "", alias);
  let parsedUrl;
  try {
    parsedUrl = new URL(sanitizedUrl);
  } catch {
    parsedUrl = null;
  }

  const result = {
    method: String(request?.method || "GET").toUpperCase(),
    url: sanitizedUrl,
    httpVersion: String(request?.httpVersion || ""),
    headers: sanitizeHeaders(request?.headers, alias),
    queryString: parsedUrl
      ? [...parsedUrl.searchParams.entries()].map(([name, value]) => ({ name, value }))
      : [],
    cookies: sanitizeCookies(request?.cookies),
    headersSize: -1,
    bodySize: Number.isFinite(request?.bodySize) ? request.bodySize : -1,
  };
  const postData = sanitizePostData(request?.postData, alias);
  if (postData) result.postData = postData;
  return result;
};

const sanitizeResponse = (response, alias) => ({
  status: Number.isFinite(response?.status) ? response.status : 0,
  statusText: "",
  httpVersion: String(response?.httpVersion || ""),
  headers: sanitizeHeaders(response?.headers, alias),
  cookies: sanitizeCookies(response?.cookies),
  content: sanitizeContent(response?.content, alias),
  redirectURL: response?.redirectURL ? sanitizeUrl(response.redirectURL, alias) : "",
  headersSize: -1,
  bodySize: Number.isFinite(response?.bodySize) ? response.bodySize : -1,
});

const sanitizeTimings = (timings) => Object.fromEntries(
  ["blocked", "dns", "connect", "send", "wait", "receive", "ssl"]
    .filter((key) => Number.isFinite(timings?.[key]))
    .map((key) => [key, timings[key]]),
);

const sanitizeEntry = (entry, alias) => ({
  startedDateTime: String(entry?.startedDateTime || ""),
  time: Number.isFinite(entry?.time) ? entry.time : 0,
  request: sanitizeRequest(entry?.request || {}, alias),
  response: sanitizeResponse(entry?.response || {}, alias),
  cache: {},
  timings: sanitizeTimings(entry?.timings),
  serverIPAddress: REDACTED,
  connection: REDACTED,
});

const pathTemplate = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "/invalid-url";
  }
  return parsed.pathname
    .replace(/\/tenant-\d{3}(?=\/|$)/gi, "/{tenant}")
    .replace(/\/[a-z0-9-]+-\d{3}(?=\/|$)/gi, "/{id}");
};

const collectSensitiveSourceTokens = (sourceText) => {
  const tokens = new Map();
  const patterns = [
    ["jwt", JWT_PATTERN],
    ["email", EMAIL_PATTERN],
    ["phone", PHONE_PATTERN],
    ["mongo-uri", MONGO_URI_PATTERN],
  ];
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of sourceText.matchAll(pattern)) tokens.set(`${kind}:${match[0]}`, {
      kind,
      value: match[0],
    });
  }
  PAN_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of sourceText.matchAll(PAN_CANDIDATE_PATTERN)) {
    if (isLikelyPan(match[0])) tokens.set(`pan:${match[0]}`, {
      kind: "pan",
      value: match[0],
    });
  }
  return [...tokens.values()].filter(({ value }) => value.length >= 6);
};

const assertNoSensitiveSourceTokens = (sourceText, sanitizedText) => {
  const leaked = collectSensitiveSourceTokens(sourceText)
    .filter(({ value }) => sanitizedText.includes(value));
  if (leaked.length > 0) {
    const byKind = Object.entries(leaked.reduce((counts, { kind }) => ({
      ...counts,
      [kind]: (counts[kind] || 0) + 1,
    }), {})).map(([kind, count]) => `${kind}=${count}`).join(", ");
    throw new Error(`Sanitization failed: ${leaked.length} sensitive source token(s) remain (${byKind})`);
  }
  JWT_PATTERN.lastIndex = 0;
  MONGO_URI_PATTERN.lastIndex = 0;
  if (JWT_PATTERN.test(sanitizedText) || MONGO_URI_PATTERN.test(sanitizedText)) {
    throw new Error("Sanitization failed: credential-like content remains");
  }
};

const buildEndpointSummary = (entries) => {
  const summary = new Map();
  for (const entry of entries) {
    const method = entry.request.method;
    const template = pathTemplate(entry.request.url);
    const status = entry.response.status;
    const key = `${method} ${template} ${status}`;
    const current = summary.get(key) || {
      method,
      pathTemplate: template,
      responseStatus: status,
      count: 0,
      requestMimeTypes: new Set(),
      responseMimeTypes: new Set(),
    };
    current.count += 1;
    if (entry.request.postData?.mimeType) current.requestMimeTypes.add(entry.request.postData.mimeType);
    if (entry.response.content?.mimeType) current.responseMimeTypes.add(entry.response.content.mimeType);
    summary.set(key, current);
  }
  return [...summary.values()]
    .map((item) => ({
      ...item,
      requestMimeTypes: [...item.requestMimeTypes].sort(),
      responseMimeTypes: [...item.responseMimeTypes].sort(),
    }))
    .sort((left, right) => (
      `${left.pathTemplate}:${left.method}:${left.responseStatus}`
        .localeCompare(`${right.pathTemplate}:${right.method}:${right.responseStatus}`)
    ));
};

export const sanitizeHarText = (sourceText, { allowedHosts, allowedPathPrefixes, caseId }) => {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new Error("At least one allowed host is required");
  }
  if (!Array.isArray(allowedPathPrefixes) || allowedPathPrefixes.length === 0) {
    throw new Error("At least one allowed path prefix is required");
  }
  if (!/^GHAR-[A-Z0-9-]+$/.test(String(caseId || ""))) {
    throw new Error("caseId must match GHAR-[A-Z0-9-]+");
  }

  let source;
  try {
    source = JSON.parse(sourceText);
  } catch {
    throw new Error("Input is not valid JSON");
  }
  if (!isObject(source?.log) || !Array.isArray(source.log.entries)) {
    throw new Error("Input is not a valid HAR log");
  }

  const normalizedHosts = [...new Set(allowedHosts.map(normalizeHost).filter(Boolean))].sort();
  if (normalizedHosts.length === 0) {
    throw new Error("At least one non-empty allowed host is required");
  }
  const normalizedPathPrefixes = [...new Set(allowedPathPrefixes.map(normalizePathPrefix))].sort();
  const alias = createAliasStore();
  const retainedEntries = [];

  for (const entry of source.log.entries) {
    let parsedUrl;
    try {
      parsedUrl = new URL(entry?.request?.url || "");
    } catch {
      continue;
    }
    if (!hostAllowed(parsedUrl.hostname, normalizedHosts)
      || !pathAllowed(parsedUrl.pathname, normalizedPathPrefixes)) continue;
    retainedEntries.push(sanitizeEntry(entry, alias));
  }

  if (retainedEntries.length === 0) {
    throw new Error("No HAR entries matched the allowed hosts and path prefixes");
  }

  const sanitizedHar = {
    log: {
      version: "1.2",
      creator: {
        name: "PadlHub HAR sanitizer",
        version: "1",
      },
      pages: [],
      entries: retainedEntries,
    },
  };

  const sanitizedText = `${JSON.stringify(sanitizedHar, null, 2)}\n`;
  assertNoSensitiveSourceTokens(sourceText, sanitizedText);

  const timestamps = retainedEntries
    .map((entry) => Date.parse(entry.startedDateTime))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  const manifest = {
    caseId,
    evidenceStatus: "SANITIZED",
    generatedAt: new Date().toISOString(),
    sourceSha256: sha256(sourceText),
    sanitizedSha256: sha256(sanitizedText),
    allowedHosts: normalizedHosts,
    allowedPathPrefixes: normalizedPathPrefixes,
    sourceEntryCount: source.log.entries.length,
    retainedEntryCount: retainedEntries.length,
    removedEntryCount: source.log.entries.length - retainedEntries.length,
    capturedFrom: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
    capturedTo: timestamps.length > 0 ? new Date(timestamps.at(-1)).toISOString() : null,
    endpoints: buildEndpointSummary(retainedEntries),
    securityChecks: {
      detectedSourceSensitiveTokensAbsent: true,
      authorizationAndCookieHeadersRedacted: true,
      thirdPartyHostsRemoved: true,
      binaryBodiesRemoved: true,
      manualReviewRequired: true,
    },
    warnings: [
      "SANITIZED is not REVIEWED or APPROVED evidence.",
      "Validate request/response semantics and pre/post readbacks separately.",
      "Do not commit the source HAR or any alias map.",
    ],
  };

  return {
    sanitizedHar,
    sanitizedText,
    manifest,
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
  };
};

const parseArgs = (argv) => {
  const result = { hosts: [], pathPrefixes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (["--input", "--output", "--manifest", "--host", "--path-prefix", "--case-id"].includes(token)
      && (!next || next.startsWith("--"))) {
      throw new Error(`Missing value for ${token}`);
    }
    if (token === "--input") result.input = next;
    else if (token === "--output") result.output = next;
    else if (token === "--manifest") result.manifest = next;
    else if (token === "--host") result.hosts.push(next);
    else if (token === "--path-prefix") result.pathPrefixes.push(next);
    else if (token === "--case-id") result.caseId = next;
    else throw new Error(`Unknown argument: ${token}`);
    index += 1;
  }
  return result;
};

const writeExclusive = (filePath, content) => {
  fs.writeFileSync(filePath, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
};

export const sanitizeHarFile = ({
  inputPath,
  outputPath,
  manifestPath,
  allowedHosts,
  allowedPathPrefixes,
  caseId,
}) => {
  const resolvedInput = path.resolve(inputPath || "");
  const resolvedOutput = path.resolve(outputPath || "");
  const resolvedManifest = path.resolve(manifestPath || "");
  if (!inputPath || !outputPath || !manifestPath) {
    throw new Error("--input, --output and --manifest are required");
  }
  if (new Set([resolvedInput, resolvedOutput, resolvedManifest]).size !== 3) {
    throw new Error("Input, output and manifest paths must be different");
  }
  if (fs.existsSync(resolvedOutput) || fs.existsSync(resolvedManifest)) {
    throw new Error("Output or manifest already exists; choose new paths");
  }

  const sourceText = fs.readFileSync(resolvedInput, "utf8");
  const result = sanitizeHarText(sourceText, { allowedHosts, allowedPathPrefixes, caseId });
  writeExclusive(resolvedOutput, result.sanitizedText);
  try {
    writeExclusive(resolvedManifest, result.manifestText);
  } catch (error) {
    fs.unlinkSync(resolvedOutput);
    throw error;
  }
  return result.manifest;
};

const usage = () => [
  "Usage:",
  "  node scripts/sanitize_viva_har.mjs \\",
  "    --input /absolute/source.har \\",
  "    --output /absolute/case.sanitized.har \\",
  "    --manifest /absolute/case.manifest.json \\",
  "    --case-id GHAR-BKG-CREATE-060 \\",
  "    --host api.vivacrm.ru --host padlhub.su \\",
  "    --path-prefix /end-user/api/v2/{tenant}/bookings",
].join("\n");

const main = () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = sanitizeHarFile({
      inputPath: args.input,
      outputPath: args.output,
      manifestPath: args.manifest,
      allowedHosts: args.hosts,
      allowedPathPrefixes: args.pathPrefixes,
      caseId: args.caseId,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      caseId: manifest.caseId,
      retainedEntryCount: manifest.retainedEntryCount,
      removedEntryCount: manifest.removedEntryCount,
      evidenceStatus: manifest.evidenceStatus,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 1;
  }
};

const isCli = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) main();
