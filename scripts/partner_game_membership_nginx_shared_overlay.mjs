// Offline production-layout preparation. No filesystem, network, subprocess or
// production-verifier calls. Caller files/pins are not trusted host observations.
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, PARTNER_API_BASE_PATH } from "../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import { PartnerIngressEvidenceError } from "./partner_game_membership_ingress_evidence.mjs";
import { scanNginxInventoryStructure } from "./partner_game_membership_nginx_lexical.mjs";
import { checkLocalSharedNginxDialect } from "./partner_game_membership_nginx_shared_dialect.mjs";

const HASH = /^[a-f0-9]{64}$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAMESPACE = "pgm_v02";
const OUTPUT_PATH = "/etc/nginx/conf.d/partner-game-membership-api-v02.conf";
const CERT_ROOT = "/etc/nginx/partner-game-membership-api-v02";
const generated = new WeakMap();
const preparations = new WeakMap();
const preservedInputs = new WeakMap();
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new PartnerIngressEvidenceError(`NGINX_SHARED_${code}`); };
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== "string")
    || !isDeepStrictEqual(Reflect.ownKeys(value).sort(), [...keys].sort())
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, "value"))) fail("INPUT_INVALID");
};
const list = (value, min, max) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, "value"))
    || !isDeepStrictEqual(Object.keys(value), Array.from({ length: value.length }, (_, i) => String(i)))) fail("INPUT_INVALID");
  return Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)).value);
};
const denied = Object.freeze({ productionVerified: false, deployAuthorized: false, activationAuthorized: false });

function byteSnapshot(bytes, max, code) {
  if (!Buffer.isBuffer(bytes) || Object.getPrototypeOf(bytes) !== Buffer.prototype
    || Reflect.ownKeys(bytes).some(key => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key))
    || !bytes.length || bytes.length > max) fail(code);
  return Buffer.from(bytes);
}
const certificateSnapshot = bytes => byteSnapshot(bytes, 32768, "PUBLIC_CERTIFICATE_INVALID");

function publicCertificates(bytes, maxCount) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 32768) fail("PUBLIC_CERTIFICATE_INVALID");
  const text = bytes.toString("utf8"), parts = text.match(/-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n/g);
  if (!parts || parts.join("") !== text || parts.length > maxCount) fail("PUBLIC_CERTIFICATE_INVALID");
  try {
    return parts.map(pem => {
      const cert = new crypto.X509Certificate(pem), key = cert.publicKey;
      if (cert.toString().trimEnd() + "\n" !== pem
        || !(key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails.modulusLength >= 2048
          || key.asymmetricKeyType === "ec" && ["prime256v1", "secp384r1"].includes(key.asymmetricKeyDetails.namedCurve))) fail("PUBLIC_CERTIFICATE_INVALID");
      return cert;
    });
  } catch (error) { if (error instanceof PartnerIngressEvidenceError) throw error; fail("PUBLIC_CERTIFICATE_INVALID"); }
}

export function generatePartnerNginxSharedOverlay(input) {
  exact(input, ["scope", "exactHost", "clients", "sourceAddresses", "generationMarker", "now",
    "clientCaCertificateBytes", "serverCertificateChainBytes",
    "approvedClientCaSha256", "approvedServerChainSha256"]);
  if (input.scope !== "LOCAL_PREPARATION" || typeof input.exactHost !== "string" || input.exactHost.length > 253
    || !HOST.test(input.exactHost)
    || !Number.isSafeInteger(input.now) || input.now < 0
    || ["generationMarker", "approvedClientCaSha256", "approvedServerChainSha256"]
      .some(key => typeof input[key] !== "string" || !HASH.test(input[key]))) fail("INPUT_INVALID");
  const sourceAddresses = list(input.sourceAddresses, 1, 8);
  if (sourceAddresses.some(ip => typeof ip !== "string" || net.isIP(ip) !== 4 || ip === "0.0.0.0" || ip === "255.255.255.255")
    || new Set(sourceAddresses).size !== sourceAddresses.length) fail("SOURCE_ALLOWLIST_INVALID");
  // Each admitted client is bound to its own exact public leaf, so a client can never claim
  // another client's id and the client list stays an explicit allowlist, not a bucket.
  const clientEntries = list(input.clients, 1, 16).map(entry => {
    exact(entry, ["clientId", "clientCertificateBytes", "approvedClientSpkiSha256"]);
    if (typeof entry.clientId !== "string" || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(entry.clientId)
      || typeof entry.approvedClientSpkiSha256 !== "string" || !HASH.test(entry.approvedClientSpkiSha256)) fail("INPUT_INVALID");
    return Object.freeze({ clientId: entry.clientId, approvedClientSpkiSha256: entry.approvedClientSpkiSha256,
      bytes: certificateSnapshot(entry.clientCertificateBytes) });
  });
  if (new Set(clientEntries.map(entry => entry.clientId)).size !== clientEntries.length
    || new Set(clientEntries.map(entry => sha(entry.bytes))).size !== clientEntries.length) fail("INPUT_INVALID");
  const caBytes = certificateSnapshot(input.clientCaCertificateBytes);
  const serverBytes = certificateSnapshot(input.serverCertificateChainBytes);
  const clients = clientEntries.map(entry => Object.freeze({ ...entry,
    cert: publicCertificates(entry.bytes, 1)[0] }));
  const [ca] = publicCertificates(caBytes, 1);
  const chain = publicCertificates(serverBytes, 6), server = chain[0];
  for (const cert of [...clients.map(client => client.cert), ca, ...chain]) {
    if (Date.parse(cert.validFrom) > input.now || Date.parse(cert.validTo) <= input.now) fail("CERTIFICATE_TIME_INVALID");
  }
  if (!ca.ca || !ca.checkIssued(ca) || !ca.verify(ca.publicKey) || server.ca
    || clients.some(client => client.cert.ca || !client.cert.checkIssued(ca) || !client.cert.verify(ca.publicKey)
      || !client.cert.keyUsage?.includes("1.3.6.1.5.5.7.3.2"))
    || !server.keyUsage?.includes("1.3.6.1.5.5.7.3.1")
    || server.checkHost(input.exactHost, { subject: "never", wildcards: false }) !== input.exactHost) fail("CERTIFICATE_BINDING_INVALID");
  for (let i = 1; i < chain.length; i++) {
    if (!chain[i].ca || !chain[i - 1].checkIssued(chain[i]) || !chain[i - 1].verify(chain[i].publicKey)) fail("CERTIFICATE_CHAIN_INVALID");
  }
  if (new Set(chain.map(cert => sha(cert.raw))).size !== chain.length) fail("CERTIFICATE_CHAIN_INVALID");
  if (clients.some(client => sha(client.cert.publicKey.export({ type: "spki", format: "der" })) !== client.approvedClientSpkiSha256)
    || sha(caBytes) !== input.approvedClientCaSha256
    || sha(serverBytes) !== input.approvedServerChainSha256) fail("CERTIFICATE_PIN_MISMATCH");
  // Reuse the established exact public-leaf admission, not SHA-1 fingerprints or
  // caller client-id buckets. No shared-host/default-server or http{} wrapper.
  // The certificate-derived identity keeps the historical $pgm_v02_client variable name: the
  // limit zones key on it, and nginx refuses a reload that changes an existing zone key, so a
  // rename would force a full restart of the shared ingress. Only the map values change.
  const leafEntries = clients.map(client => `"~^${encodeURIComponent(client.bytes.toString())}$" "${client.clientId}";`).join(" ");
  const admittedEntries = clients.map(client => `"SUCCESS:${client.clientId}" 1;`).join(" ");
  const boundEntries = clients.map(client => `"${client.clientId}:${client.clientId}" 1;`).join(" ");
  const configuration = `# OFFLINE SHARED OVERLAY DRAFT: native review/application still required.
map $ssl_client_escaped_cert $pgm_v02_client { default ""; ${leafEntries} }
map $ssl_client_verify $pgm_v02_verified { SUCCESS 1; default 0; }
map "$ssl_client_verify:$pgm_v02_client" $pgm_v02_admitted { default 0; ${admittedEntries} }
map "$pgm_v02_client:$http_x_padlhub_client_id" $pgm_v02_client_bound { default 0; ${boundEntries} }
map "$http_transfer_encoding$http_content_encoding$http_trailer$http_expect$http_upgrade$http_proxy_connection" $pgm_v02_bad_framing { "" 0; default 1; }
map $http_connection $pgm_v02_bad_connection { "" 0; ~*^(close|keep-alive)$ 0; default 1; }
map "$request_method:$request_uri" $pgm_v02_route {
  default 0;
  "~^POST:${PARTNER_API_BASE_PATH}/open-games/[A-Za-z0-9_-]{1,160}/members$" 1;
  "~^DELETE:${PARTNER_API_BASE_PATH}/open-games/[A-Za-z0-9_-]{1,160}/members/[A-Za-z0-9_-]{1,160}$" 1;
  "~^GET:${PARTNER_API_BASE_PATH}/operations/[A-Za-z0-9_-]{1,160}$" 1;
}
limit_req_zone $pgm_v02_client zone=pgm_v02_client_rate:1m rate=2r/s;
limit_req_zone $binary_remote_addr zone=pgm_v02_source_rate:1m rate=5r/s;
limit_conn_zone $pgm_v02_client zone=pgm_v02_client_connections:1m;
limit_conn_zone $binary_remote_addr zone=pgm_v02_source_connections:1m;
log_format pgm_v02_audit escape=json '{"admitted":"$pgm_v02_admitted","client":"$pgm_v02_client","clientVerified":"$pgm_v02_verified","concurrency":"$limit_conn_status","generation":"${input.generationMarker}","rate":"$limit_req_status","requestId":"$request_id","status":"$status","upstream":"$upstream_status","worker":"$pid"}';
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${input.exactHost};
  ssl_certificate ${CERT_ROOT}/server-chain.pem;
  ssl_certificate_key ${CERT_ROOT}/server.key;
  ssl_client_certificate ${CERT_ROOT}/client-ca.pem;
  ssl_verify_client on;
  ssl_verify_depth 1;
  ssl_protocols TLSv1.2 TLSv1.3;
  # Declare the remaining inherited controls explicitly instead of relying on the
  # shared http{} profile, whose root ssl_protocols/prefer_server_ciphers and header
  # defaults are not part of the reviewed partner profile.
  ssl_prefer_server_ciphers off;
  ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";
  ssl_early_data off;
  ssl_session_tickets off;
  ssl_session_cache off;
  server_tokens off;
  client_max_body_size 16k;
  client_body_buffer_size 16k;
  client_body_in_file_only off;
  client_header_buffer_size 2k;
  large_client_header_buffers 7 2k;
  client_header_timeout 5s;
  client_body_timeout 5s;
  ignore_invalid_headers on;
  underscores_in_headers off;
  keepalive_timeout 0;
  send_timeout 15s;
  add_header Cache-Control no-store always;
  add_header X-Padlhub-Ingress-Request-Id $request_id always;
  gzip off;
  access_log /var/log/nginx/partner-game-membership-api-v02.audit.jsonl pgm_v02_audit;
  error_log /dev/null crit;
  limit_req_status 429;
  limit_conn_status 429;
  limit_req_dry_run off;
  limit_conn_dry_run off;
  satisfy all;
  if ($ssl_server_name != "${input.exactHost}") { return 421; }
  if ($http_host != "${input.exactHost}") { return 421; }
  if ($ssl_protocol !~ "^TLSv1\\.[23]$") { return 403; }
  if ($pgm_v02_admitted = 0) { return 403; }
  if ($pgm_v02_client_bound = 0) { return 403; }
  if ($pgm_v02_bad_framing) { return 400; }
  if ($pgm_v02_bad_connection) { return 400; }
  if ($pgm_v02_route = 0) { return 404; }
  location / {
${sourceAddresses.sort().map(ip => `    allow ${ip};`).join("\n")}
    deny all;
    limit_req zone=pgm_v02_client_rate burst=10 nodelay;
    limit_req zone=pgm_v02_source_rate burst=20 nodelay;
    limit_conn pgm_v02_client_connections 4;
    limit_conn pgm_v02_source_connections 8;
    proxy_pass http://127.0.0.1:18894;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection close;
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host "";
    proxy_set_header X-Forwarded-Proto "";
    proxy_set_header X-Forwarded-Port "";
    proxy_set_header X-Real-IP "";
    proxy_request_buffering off;
    proxy_pass_request_headers on;
    proxy_pass_request_body on;
    proxy_redirect off;
    proxy_ignore_headers X-Accel-Redirect X-Accel-Expires X-Accel-Limit-Rate X-Accel-Buffering X-Accel-Charset;
    proxy_buffering off;
    proxy_cache off;
    proxy_store off;
    proxy_intercept_errors off;
    proxy_next_upstream off;
    proxy_connect_timeout 15s;
    proxy_send_timeout 15s;
    proxy_read_timeout 15s;
    proxy_hide_header Cache-Control;
    proxy_hide_header X-Padlhub-Ingress-Request-Id;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Expose-Headers;
    proxy_hide_header Access-Control-Max-Age;
  }
}
`;
  const result = Object.freeze({ state: "LOCAL_NGINX_SHARED_OVERLAY_DRAFT_NOT_DEPLOYABLE", path: OUTPUT_PATH,
    configuration, configSha256: sha(configuration), generationMarker: input.generationMarker,
    serverChainSha256: input.approvedServerChainSha256, clientCaSha256: input.approvedClientCaSha256,
    clients: Object.freeze(clients.map(client => Object.freeze({ clientId: client.clientId,
      clientSpkiSha256: client.approvedClientSpkiSha256, clientLeafSha256: sha(client.cert.raw) }))), ...denied,
    unresolvedControls: Object.freeze(["TRUSTED_HOST_CLOSURE_AND_FILE_CUSTODY", "SHARED_LISTENER_TLS_AND_HEADER_INHERITANCE",
      "SHARED_VHOST_SEMANTICS_AND_ROUTE_ISOLATION", "SERVER_PKI_TRUST_AND_KEY_CUSTODY", "LIVE_RAW_GUARD_AND_RUNTIME_PROOF",
      "ALL_WORKER_GENERATION_AND_APPLICATION", "EXTERNAL_PROBES_AND_REVOCATION"]),
  });
  generated.set(result, { configuration, exactHost: input.exactHost,
    clients: Object.freeze(clients.map(client => Object.freeze({ clientId: client.clientId,
      clientLeafSha256: sha(client.cert.raw) }))),
    sourceAddresses: Object.freeze([...sourceAddresses]),
    serverSpkiSha256: sha(server.publicKey.export({ type: "spki", format: "der" })) });
  return result;
}

// Closed local preparation, not an operator, host observation or deployment plan.
export function prepareLocalNginxSharedAdapter(input) {
  const preservation = verifyLocalNginxSharedOverlayChange(input);
  const dialect = checkLocalSharedNginxDialect(preservedInputs.get(preservation));
  const own = generated.get(input.overlay);
  const result = Object.freeze({ state: "LOCAL_SHARED_ADAPTER_PREPARED_NOT_DEPLOYABLE", preservation, dialect,
    ...denied });
  preparations.set(result, Object.freeze({ baselineSha256: preservation.baselineSha256,
    candidateSha256: preservation.candidateSha256, overlaySha256: preservation.overlaySha256,
    generationMarker: input.overlay.generationMarker, exactHost: own.exactHost, clients: own.clients,
    sourceAddresses: own.sourceAddresses, serverSpkiSha256: own.serverSpkiSha256 }));
  return result;
}

export function readLocalNginxSharedAdapterBinding(preparation) {
  const value = preparations.get(preparation);
  if (!value) fail("SOURCE_OWNED_PREPARATION_REQUIRED");
  return value;
}

function files(value) {
  const items = list(value, 1, 64);
  let total = 0;
  const output = new Map();
  for (const item of items) {
    exact(item, ["path", "bytes"]);
    if (typeof item.path !== "string" || !/^\/etc\/(?:nginx\/[A-Za-z0-9_./-]+|letsencrypt\/options-ssl-nginx\.conf)$/.test(item.path)
      || path.posix.normalize(item.path) !== item.path || /(?:\.key|\.pem|\.env|\.log)$/.test(item.path)
      || output.has(item.path)) fail("CLOSURE_INVALID");
    const bytes = byteSnapshot(item.bytes, 131072, "CLOSURE_INVALID");
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) fail("CLOSURE_INVALID");
    total += bytes.length;
    if (total > 1048576) fail("CLOSURE_INVALID");
    output.set(item.path, bytes);
  }
  if (!output.has("/etc/nginx/nginx.conf")) fail("ENTRYPOINT_MISSING");
  return output;
}
const manifest = entries => sha(canonicalJson([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([name, bytes]) => ({ path: name, sha256: sha(bytes) }))));

// A digest of caller-supplied bytes, not a host observation or approval issuer.
export function hashLocalNginxClosure(value) { return manifest(files(value)); }

export function verifyLocalNginxSharedOverlayChange(input) {
  exact(input, ["baselineFiles", "candidateFiles", "expectedBaselineSha256", "overlay"]);
  const own = generated.get(input.overlay);
  if (!own) fail("SOURCE_OWNED_OVERLAY_REQUIRED");
  const baseline = files(input.baselineFiles), candidate = files(input.candidateFiles);
  if (typeof input.expectedBaselineSha256 !== "string" || !HASH.test(input.expectedBaselineSha256)
    || manifest(baseline) !== input.expectedBaselineSha256) fail("BASELINE_PIN_MISMATCH");
  if (baseline.has(OUTPUT_PATH)) fail("OVERLAY_ALREADY_EXISTS");
  if (candidate.size !== baseline.size + 1 || !candidate.get(OUTPUT_PATH)?.equals(Buffer.from(own.configuration))) fail("EXACT_ADDITION_REQUIRED");
  for (const [name, bytes] of baseline) if (!candidate.get(name)?.equals(bytes)) fail("EXISTING_FILE_CHANGED");
  const records = new Map();
  let admittedIncludes = 0;
  for (const [name, bytes] of baseline) {
    let rows;
    try { rows = scanNginxInventoryStructure(bytes.toString("utf8")); } catch { fail("CLOSURE_DIALECT_UNSUPPORTED"); }
    for (const row of rows) {
      const [head, ...args] = row.words;
      if (head.quoted && ["include", "server_name", "map", "geo", "log_format", "limit_req_zone", "limit_conn_zone"].includes(head.value)) fail("CLOSURE_DIALECT_UNSUPPORTED");
      if (row.words.some(word => word.value.toLowerCase().includes(NAMESPACE))) fail("NAMESPACE_COLLISION");
      if (head.value === "server_name") {
        if (args.some(arg => arg.value.toLowerCase().replace(/\.$/, "") === own.exactHost)) fail("HOST_COLLISION");
        if (args.some(arg => /[~*$]/.test(arg.value) || arg.value.startsWith("."))) fail("SERVER_SELECTION_UNPROVEN");
      }
      if (head.value === "include" && args.some(arg => arg.value === "/etc/nginx/conf.d/*.conf")) {
        if (name !== "/etc/nginx/nginx.conf" || row.block || !isDeepStrictEqual(row.context, ["http"])
          || args.length !== 1 || ++admittedIncludes !== 1) fail("HTTP_INCLUDE_NOT_PROVEN");
      }
    }
    records.set(name, rows);
  }
  if (admittedIncludes !== 1) fail("HTTP_INCLUDE_NOT_PROVEN");
  const reached = new Set(), contexts = new Set();
  const visit = (name, stack = [], inheritedContext = []) => {
    if (stack.includes(name) || stack.length > 8) fail("INCLUDE_CYCLE_OR_DEPTH");
    const contextKey = canonicalJson([name, inheritedContext]);
    if (contexts.has(contextKey)) return;
    if (contexts.size >= 2048 || inheritedContext.length > 256) fail("CLOSURE_DIALECT_UNSUPPORTED");
    contexts.add(contextKey);
    reached.add(name);
    for (const row of records.get(name)) {
      const effectiveContext = [...inheritedContext, ...row.context];
      if (isDeepStrictEqual(effectiveContext, ["http"])
        && ["set_real_ip_from", "real_ip_header", "real_ip_recursive"].includes(row.words[0].value)) fail("INHERITED_REALIP_UNSUPPORTED");
      if (row.words[0].value !== "include") continue;
      if (row.block || row.words.length !== 2) fail("INCLUDE_UNSUPPORTED");
      const pattern = row.words[1].value;
      let targets;
      if (["/etc/nginx/conf.d/*.conf", "/etc/nginx/sites-enabled/*", "/etc/nginx/modules-enabled/*.conf"].includes(pattern)) {
        const dir = path.posix.dirname(pattern) + "/";
        targets = [...baseline.keys()].filter(p => p.startsWith(dir) && !p.slice(dir.length).includes("/")
          && !p.slice(dir.length).startsWith(".") && (!pattern.endsWith(".conf") || p.endsWith(".conf")));
      } else {
        if (!baseline.has(pattern) || /[?*$]/.test(pattern)) fail("UNKNOWN_LITERAL_INCLUDE");
        targets = [pattern];
      }
      for (const target of targets) visit(target, [...stack, name], effectiveContext);
    }
  };
  visit("/etc/nginx/nginx.conf");
  if (reached.size !== baseline.size) fail("UNREACHABLE_BASELINE_FILE");
  const result = Object.freeze({ state: "LOCAL_SHARED_OVERLAY_BYTE_PRESERVATION_CHECKED_NOT_LIVE_PROOF",
    baselineSha256: manifest(baseline), candidateSha256: manifest(candidate), overlaySha256: sha(own.configuration),
    preservedFileCount: baseline.size, addedFileCount: 1, ...denied,
    provenance: "CALLER_SUPPLIED_BYTES_NOT_HOST_ATTESTED", filesystemCustody: "NOT_CHECKED",
    semanticPreservation: "NOT_PROVEN", workerGeneration: "NOT_OBSERVED" });
  preservedInputs.set(result, baseline);
  return result;
}
