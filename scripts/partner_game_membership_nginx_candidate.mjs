import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PartnerIngressEvidenceError } from "./partner_game_membership_ingress_evidence.mjs";

const fail = code => { throw new PartnerIngressEvidenceError(code); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail("INVALID_NGINX_CANDIDATE_INPUT");
};
const fixtureHost = value => typeof value === "string" && value.length <= 160
  && /^(?:[a-z][a-z0-9-]*\.)+invalid$/.test(value);

function certificate(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8192
    || !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n$/.test(bytes.toString())) {
    fail("INVALID_NGINX_PUBLIC_CERTIFICATE");
  }
  try {
    const cert = new crypto.X509Certificate(bytes);
    if (!Buffer.from(cert.toString().trimEnd() + "\n").equals(bytes)) fail("NON_CANONICAL_NGINX_CERTIFICATE");
    if (cert.publicKey.asymmetricKeyType !== "rsa" || cert.publicKey.asymmetricKeyDetails.modulusLength < 2048) {
      fail("UNSUPPORTED_NGINX_CERTIFICATE_KEY");
    }
    return cert;
  } catch (error) {
    if (error instanceof PartnerIngressEvidenceError) throw error;
    fail("INVALID_NGINX_PUBLIC_CERTIFICATE");
  }
}

// No file reads, command execution, install, public listener or production input.
// This closes a testable config dialect, NOT the production application boundary.
export function generatePartnerNginx124Candidate(input) {
  exact(input, ["scope", "exactHost", "sharedHost", "clientCertificateBytes", "serverCertificateBytes", "caCertificateBytes", "approvedClientSpkiSha256", "now"]);
  if (input.scope !== "LOCAL_FIXTURE" || !fixtureHost(input.exactHost) || !fixtureHost(input.sharedHost)
    || input.exactHost === input.sharedHost || !Number.isSafeInteger(input.now)
    || !/^[a-f0-9]{64}$/.test(input.approvedClientSpkiSha256)) fail("INVALID_NGINX_CANDIDATE_INPUT");
  const client = certificate(input.clientCertificateBytes);
  const server = certificate(input.serverCertificateBytes);
  const ca = certificate(input.caCertificateBytes);
  for (const cert of [client, server, ca]) {
    if (Date.parse(cert.validFrom) > input.now || Date.parse(cert.validTo) <= input.now) fail("NGINX_CERTIFICATE_EXPIRED_OR_FUTURE");
  }
  if (!ca.ca || client.ca || server.ca || !client.verify(ca.publicKey) || !server.verify(ca.publicKey)
    || !client.checkIssued(ca) || !server.checkIssued(ca)
    || !client.keyUsage?.includes("1.3.6.1.5.5.7.3.2") || !server.keyUsage?.includes("1.3.6.1.5.5.7.3.1")
    || server.checkHost(input.exactHost, { subject: "never", wildcards: false }) !== input.exactHost
    || server.checkHost(input.sharedHost, { subject: "never", wildcards: false }) !== input.sharedHost) {
    fail("NGINX_CERTIFICATE_BINDING_REJECTED");
  }
  if (hash(client.publicKey.export({ type: "spki", format: "der" })) !== input.approvedClientSpkiSha256) fail("NGINX_CLIENT_SPKI_MISMATCH");
  // Nginx exposes a SHA-1 fingerprint, not SPKI SHA-256. Pin the entire canonical
  // public leaf instead, after checking the independently supplied SPKI SHA-256.
  const leaf = encodeURIComponent(input.clientCertificateBytes.toString());
  const configuration = `# LOCAL FIXTURE ONLY: not a shared-server include or deploy artifact.
pid /tmp/nginx.pid;
worker_processes 1;
error_log /dev/null crit;
events { worker_connections 128; }
http {
  map_hash_bucket_size 4096;
  log_format partner escape=json '{"requestId":"$request_id","status":"$status","upstream":"$upstream_status","clientVerified":"$partner_verified","rate":"$limit_req_status","concurrency":"$limit_conn_status"}';
  access_log /out/nginx-access.jsonl partner;
  client_body_temp_path /tmp/body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server_tokens off;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_early_data off;
  ssl_session_tickets off;
  ssl_session_cache off;
  client_max_body_size 16k;
  # Conservative aggregate ceiling: initial 2k PLUS seven large 2k buffers.
  # Request line and partial-field copies also consume this 16k budget; this
  # is not an exact header-only acceptance threshold. Keep HTTP/2 and reuse off.
  client_header_buffer_size 2k;
  large_client_header_buffers 7 2k;
  client_header_timeout 5s;
  client_body_timeout 5s;
  keepalive_timeout 0;
  send_timeout 15s;
  add_header Cache-Control no-store always;
  map $ssl_client_escaped_cert $partner_client { default ""; "~^${leaf}$" fixture-client; }
  map $ssl_client_verify $partner_verified { SUCCESS 1; default 0; }
  map "$ssl_client_verify:$partner_client" $partner_admitted { default 0; "SUCCESS:fixture-client" 1; }
  map "$http_transfer_encoding$http_content_encoding$http_trailer$http_expect$http_upgrade$http_proxy_connection" $bad_framing { "" 0; default 1; }
  map $http_connection $bad_connection { "" 0; ~*^(close|keep-alive)$ 0; default 1; }
  map "$request_method:$request_uri" $partner_route {
    default 0;
    "~^POST:/lk/integrations/v1/open-games/[A-Za-z0-9_-]{1,160}/members$" 1;
    "~^DELETE:/lk/integrations/v1/open-games/[A-Za-z0-9_-]{1,160}/members/[A-Za-z0-9_-]{1,160}$" 1;
    "~^GET:/lk/integrations/v1/operations/[A-Za-z0-9_-]{1,160}$" 1;
  }
  limit_req_zone $partner_client zone=partner_client_rate:1m rate=2r/s;
  limit_req_zone $binary_remote_addr zone=partner_source_rate:1m rate=5r/s;
  limit_conn_zone $partner_client zone=partner_client_connections:1m;
  limit_conn_zone $binary_remote_addr zone=partner_source_connections:1m;
  limit_req_status 429;
  limit_conn_status 429;
  server { listen 127.0.0.1:8443 ssl default_server; server_name _; ssl_reject_handshake on; return 421; }
  server {
    listen 127.0.0.1:8443 ssl;
    server_name ${input.sharedHost};
    ssl_certificate /fixture/server.crt;
    ssl_certificate_key /fixture/server.key;
    return 404;
  }
  server {
    listen 127.0.0.1:8443 ssl;
    server_name ${input.exactHost};
    ssl_certificate /fixture/server.crt;
    ssl_certificate_key /fixture/server.key;
    ssl_client_certificate /fixture/ca.crt;
    ssl_verify_client on;
    ssl_verify_depth 1;
    if ($ssl_server_name != "${input.exactHost}") { return 421; }
    if ($http_host != "${input.exactHost}") { return 421; }
    if ($partner_admitted = 0) { return 403; }
    if ($bad_framing) { return 400; }
    if ($bad_connection) { return 400; }
    if ($partner_route = 0) { return 404; }
    location / {
      allow 127.0.0.1;
      deny all;
      limit_req zone=partner_client_rate burst=10 nodelay;
      limit_req zone=partner_source_rate burst=20 nodelay;
      limit_conn partner_client_connections 4;
      limit_conn partner_source_connections 8;
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
      proxy_buffering off;
      proxy_next_upstream off;
      proxy_connect_timeout 15s;
      proxy_send_timeout 15s;
      proxy_read_timeout 15s;
      proxy_hide_header Cache-Control;
      proxy_hide_header Access-Control-Allow-Origin;
      proxy_hide_header Access-Control-Allow-Credentials;
      proxy_hide_header Access-Control-Allow-Headers;
      proxy_hide_header Access-Control-Allow-Methods;
      proxy_hide_header Access-Control-Expose-Headers;
      proxy_hide_header Access-Control-Max-Age;
    }
  }
}
`;
  return Object.freeze({
    state: "LOCAL_NGINX_124_CANDIDATE_NOT_DEPLOYABLE", configuration,
    configSha256: hash(Buffer.from(configuration)), clientSpkiSha256: input.approvedClientSpkiSha256,
    certificateHashes: Object.freeze(Object.fromEntries(["client", "server", "ca"].map(name => [name, hash(input[`${name}CertificateBytes`])]))),
    productionVerified: false, deployAuthorized: false, activationAuthorized: false,
    unresolvedControls: Object.freeze(["WILDCARD_FORWARDED_HEADERS", "SOURCE_LIMIT_INDEPENDENT_PROOF", "CONTROLLED_PRODUCTION_APPLICATION", "EXTERNAL_VANTAGE_AND_DIRECT_SIDECAR", "PRODUCTION_CERTIFICATE_REVOCATION"]),
  });
}
