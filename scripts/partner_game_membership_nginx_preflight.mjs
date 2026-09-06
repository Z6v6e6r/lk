import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PartnerIngressEvidenceError, parseCanonicalIngressJson } from "./partner_game_membership_ingress_evidence.mjs";

// Legacy baseline-source capability diagnostic, not the guarded startup proof.
// It still does not observe a live guard or effective ingress configuration.
// Updating the packet controls pin must never promote its NOT_PROVEN results.
const SOURCE_PINS = Object.freeze({
  core: "69781e532d5398ff827e839ba9ce11094dd5c0e413f4ea86c76711c37008f283",
  node: "196bddb4df6116364f75f29995e95cc3716ee71d725bf848a3c81c6526d08c74",
  settings: "37e675a39f12d2a23352578cd7f1068e0b5ae1d3d92649e5078f0050a6448e3d",
});
const CONTROLS_PIN = "0bd15e7c61516784aaf4506e911bf99b4a71df77bdf61e752f445e3f3e838a11";
const HASH = /^[a-f0-9]{64}$/;
const KNOWN_FLAGS = Object.freeze([
  "--with-http_ssl_module", "--with-http_v2_module", "--with-control-api",
  "--without-http_limit_req_module", "--without-http_limit_conn_module",
]);
const fail = code => { throw new PartnerIngressEvidenceError(code); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys, code) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail(code);
};
const bounded = (value, maximum, code) => {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > maximum) fail(code);
};

// Pure, offline capability diagnostics. There is no shell, file, HTTP, TLS,
// reload, config generation, or production-verifier invocation in this module.
// expectedBuildMetadataSha256 pins a separately supplied sanitized observation;
// it does NOT turn that observation into trusted running-process evidence.
export function preflightPartnerNginx124(input) {
  exact(input, ["buildMetadataBytes", "expectedBuildMetadataSha256", "controlsBytes", "sidecarSources"], "INVALID_NGINX_PREFLIGHT_INPUT");
  bounded(input.buildMetadataBytes, 4096, "INVALID_NGINX_BUILD_METADATA");
  if (typeof input.expectedBuildMetadataSha256 !== "string" || !HASH.test(input.expectedBuildMetadataSha256)
    || hash(input.buildMetadataBytes) !== input.expectedBuildMetadataSha256) fail("NGINX_BUILD_METADATA_HASH_MISMATCH");
  const metadata = parseCanonicalIngressJson(input.buildMetadataBytes, 4096);
  exact(metadata, ["formatVersion", "kind", "version", "distribution", "inspectedFlags", "presentFlags"], "INVALID_NGINX_BUILD_METADATA");
  if (metadata.formatVersion !== 1 || metadata.kind !== "SANITIZED_NGINX_BUILD_CAPABILITIES"
    || metadata.version !== "1.24.0" || metadata.distribution !== "Ubuntu"
    || !isDeepStrictEqual(metadata.inspectedFlags, KNOWN_FLAGS)
    || !Array.isArray(metadata.presentFlags)
    || metadata.presentFlags.some(flag => typeof flag !== "string" || !KNOWN_FLAGS.includes(flag))
    || new Set(metadata.presentFlags).size !== metadata.presentFlags.length) fail("UNSUPPORTED_NGINX_BUILD_METADATA");
  bounded(input.controlsBytes, 65536, "INVALID_NGINX_CONTROLS_BYTES");
  if (hash(input.controlsBytes) !== CONTROLS_PIN) fail("NGINX_CONTROLS_DRIFT");
  exact(input.sidecarSources, Object.keys(SOURCE_PINS), "INVALID_NGINX_SIDECAR_SOURCES");
  for (const [key, pin] of Object.entries(SOURCE_PINS)) {
    bounded(input.sidecarSources[key], 1048576, "INVALID_NGINX_SIDECAR_SOURCE_BYTES");
    if (hash(input.sidecarSources[key]) !== pin) fail("NGINX_SIDECAR_SOURCE_DRIFT");
  }

  const present = new Set(metadata.presentFlags);
  const blockers = [];
  if (!present.has("--with-http_ssl_module")) blockers.push("NGINX_SSL_MODULE_MISSING");
  if (present.has("--without-http_limit_req_module")) blockers.push("NGINX_REQUEST_LIMIT_MODULE_DISABLED");
  if (present.has("--without-http_limit_conn_module")) blockers.push("NGINX_CONNECTION_LIMIT_MODULE_DISABLED");
  // A control flag in an otherwise stock Ubuntu 1.24 observation signals an
  // unreviewed patched build, never automatic admission of a newer adapter.
  if (present.has("--with-control-api")) blockers.push("NGINX_UNREVIEWED_CONTROL_API_BUILD");
  blockers.push("RAW_DUPLICATE_HEADERS_GUARD_UNPROVEN", "RAW_DUPLICATE_JSON_GUARD_UNPROVEN", "EFFECTIVE_CONFIG_UNPROVABLE");

  const controls = JSON.parse(input.controlsBytes.toString("utf8")).ingress;
  const requirements = [
    ...Object.keys(controls.routing).map(name => `routing.${name}`),
    ...Object.keys(controls.transport).map(name => `transport.${name}`),
    ...Object.keys(controls.requestPolicy).map(name => `requestPolicy.${name}`),
    ...Object.keys(controls.responsePolicy).map(name => `responsePolicy.${name}`),
  ].sort();
  const raw = new Set([
    "requestPolicy.duplicateCriticalHeadersRejected", "requestPolicy.duplicateJsonKeysRejected",
    "requestPolicy.criticalHeaders", "requestPolicy.preserveCanonicalJsonSemantics",
  ]);
  // Ownership is a design obligation, NOT implementation or live proof. The
  // metadata does not demonstrate any of these controls actually being active.
  const coverage = requirements.map(control => Object.freeze({
    control, owner: raw.has(control) ? "RAW_REQUEST_BEFORE_NODERED_PARSER" : "NGINX_CORE_OR_HOST_BINDING",
    evidence: "NOT_PROVEN",
  }));
  return Object.freeze({
    state: "LOCAL_NGINX_124_CAPABILITY_CHECKED_NOT_ACTIVE", decision: "BLOCKED",
    buildMetadataSha256: hash(input.buildMetadataBytes), controlsSha256: CONTROLS_PIN,
    sidecarSourceSha256: SOURCE_PINS, version: metadata.version,
    loadedConfigurationEvidence: "NOT_COLLECTED", rawGuardEvidence: "NOT_PROVEN",
    productionVerified: false, configGenerationAllowed: false,
    deployAuthorized: false, activationAuthorized: false,
    blockers: Object.freeze(blockers), coverage: Object.freeze(coverage),
  });
}
