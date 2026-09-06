// Read-only transport observations, NOT an ingress verdict or production adapter.
// Only a trusted operator may invoke this on an independently approved target.
// No CLI, DNS, redirects, proxy/env hooks, business writes or supplied observations.
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { PARTNER_INGRESS_REQUIRED_PROBES, PartnerIngressEvidenceError } from "./partner_game_membership_ingress_evidence.mjs";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new PartnerIngressEvidenceError(code); };
const HASH = /^[a-f0-9]{64}$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PROBE_MS = 5000, SESSION_MS = 60000, MAX_BODY = 16384, MAX_HEADERS = 16384;
const TLS_ALERTS = new Set(["ERR_SSL_TLSV1_UNRECOGNIZED_NAME", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED", "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA", "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED", "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN"]);
const KEYS = ["targetAddress", "sourceAddress", "port", "sidecarPort", "exactHost", "sharedHost",
  "serverCaBytes", "clientCertificateBytes", "clientKeyBytes", "wrongClientCertificateBytes", "wrongClientKeyBytes",
  "approvedServerSpkiSha256", "approvedClientSpkiSha256", "approvedWrongClientSpkiSha256"];
const BUFFER_KEYS = KEYS.filter(key => key.endsWith("Bytes"));
const exact = value => value && Object.getPrototypeOf(value) === Object.prototype
  && isDeepStrictEqual(Object.keys(value).sort(), [...KEYS].sort());
const spki = key => hash(key.export({ type: "spki", format: "der" }));

function publicCertificate(bytes) {
  if (!/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n$/.test(bytes.toString())) fail("INVALID_NGINX_PROBE_CERTIFICATE");
  const cert = new crypto.X509Certificate(bytes);
  if (!Buffer.from(cert.toString().trimEnd() + "\n").equals(bytes)) fail("INVALID_NGINX_PROBE_CERTIFICATE");
  return cert;
}
function validKey(key) {
  return key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails.modulusLength >= 2048
    || key.asymmetricKeyType === "ec" && ["prime256v1", "secp384r1"].includes(key.asymmetricKeyDetails.namedCurve);
}
function prepare(input) {
  if (!exact(input)) fail("INVALID_NGINX_PROBE_INPUT");
  const options = { ...input };
  for (const field of BUFFER_KEYS) {
    if (!Buffer.isBuffer(input[field]) || !input[field].length || input[field].length > 8192) fail("INVALID_NGINX_PROBE_INPUT");
  }
  for (const field of ["targetAddress", "sourceAddress"]) {
    // Deliberately narrow IPv4 dialect: no DNS, octal, mapped IPv6 or zone IDs.
    if (typeof options[field] !== "string" || net.isIP(options[field]) !== 4
      || options[field].split(".").map(Number).join(".") !== options[field]
      || /^(?:0|224|22[5-9]|23\d|24\d|25[0-5])\./.test(options[field])
      || options[field] === "255.255.255.255") fail("INVALID_NGINX_PROBE_ADDRESS");
  }
  for (const field of ["port", "sidecarPort"]) if (!Number.isSafeInteger(options[field]) || options[field] < 1 || options[field] > 65535) fail("INVALID_NGINX_PROBE_PORT");
  if (options.port === options.sidecarPort) fail("INVALID_NGINX_PROBE_PORT");
  for (const field of ["exactHost", "sharedHost"]) if (typeof options[field] !== "string" || options[field].length > 253 || !HOST.test(options[field])) fail("INVALID_NGINX_PROBE_HOST");
  if (options.exactHost === options.sharedHost || [options.exactHost, options.sharedHost].includes("unbound.invalid")) fail("INVALID_NGINX_PROBE_HOST");
  for (const field of KEYS.filter(key => key.endsWith("Sha256"))) if (typeof options[field] !== "string" || !HASH.test(options[field])) fail("INVALID_NGINX_PROBE_PIN");
  if (options.approvedClientSpkiSha256 === options.approvedWrongClientSpkiSha256) fail("NGINX_PROBE_CLIENTS_NOT_DISTINCT");
  // Snapshot mutable caller buffers before the first await. Private copies are
  // cleared on exit; OpenSSL/KeyObjects are managed by Node, not securely erased.
  for (const field of BUFFER_KEYS) options[field] = Buffer.from(input[field]);
  try {
    const ca = publicCertificate(options.serverCaBytes);
    if (!ca.ca || !validKey(ca.publicKey)) fail("INVALID_NGINX_PROBE_CERTIFICATE");
    const now = Date.now();
    const certificates = [ca];
    for (const prefix of ["client", "wrongClient"]) {
      const cert = publicCertificate(options[`${prefix}CertificateBytes`]);
      const key = crypto.createPrivateKey(options[`${prefix}KeyBytes`]);
      const pin = options[prefix === "client" ? "approvedClientSpkiSha256" : "approvedWrongClientSpkiSha256"];
      if (!validKey(cert.publicKey) || !validKey(key) || !cert.checkPrivateKey(key) || spki(cert.publicKey) !== pin) fail("NGINX_PROBE_CLIENT_KEY_MISMATCH");
      options[`${prefix}LeafSha256`] = hash(cert.raw); certificates.push(cert);
    }
    if (certificates.some(cert => Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now)) fail("NGINX_PROBE_CERTIFICATE_TIME_INVALID");
    return options;
  } catch (error) {
    for (const field of BUFFER_KEYS) options[field].fill(0);
    if (error instanceof PartnerIngressEvidenceError) throw error;
    fail("INVALID_NGINX_PROBE_CERTIFICATE");
  }
}

function plan(id, options, challenge) {
  const probeId = hash(`PADLHUB-NGINX-PROBE-V1\n${challenge}\n${id}`);
  const route = `/lk/integrations/v1/operations/ingress-probe-${probeId}`;
  return { id, probeId, servername: id === "wrongSni" ? "unbound.invalid" : id === "sharedHost" ? options.sharedHost : options.exactHost,
    host: id === "wrongHost" ? "unbound.invalid" : id === "sharedHost" ? options.sharedHost : options.exactHost,
    path: id === "editorAdmin" ? "/flows" : id === "query" ? `${route}?probe=1` : route,
    method: id === "options" ? "OPTIONS" : "GET",
    client: id === "noClientCertificate" || id === "directSidecar" ? null : id === "wrongClientCertificate" ? "wrongClient" : "client" };
}

function observe(probe, options, window) {
  return new Promise(resolve => {
    const start = performance.now();
    const result = { id: probe.id, probeId: probe.probeId, outcome: "TRANSPORT_ERROR", errorCode: null, httpStatus: null,
      complete: false, tlsAuthorized: false, tlsProtocol: null, alpnProtocol: null,
      serverLeafSha256: null, serverSpkiSha256: null, actualClientLeafSha256: null,
      sourceAddress: null, peerAddress: null, peerPort: null,
      cacheControl: null, corsHeaderPresent: false, bodyBytes: 0, bodySha256: null,
      startedAt: Date.now(), completedAt: null };
    let socket, request, agent, response, finished = false;
    const withinWindow = () => performance.now() - start < PROBE_MS && performance.now() - window.monotonic < SESSION_MS
      && Date.now() >= window.wall && Date.now() - window.wall < SESSION_MS;
    const finish = (outcome, errorCode = null) => {
      if (finished) return;
      finished = true;
      if (!withinWindow()) { outcome = "TIMEOUT"; errorCode = "PROBE_DEADLINE"; result.complete = false; }
      clearTimeout(timer);
      response?.destroy(); request?.destroy(); socket?.destroy(); agent?.destroy();
      resolve({ ...result, outcome, errorCode, completedAt: Date.now() });
    };
    const guard = () => { if (finished) return false; if (!withinWindow()) { finish("TIMEOUT", "PROBE_DEADLINE"); return false; } return true; };
    const timer = setTimeout(() => finish("TIMEOUT", "PROBE_DEADLINE"), Math.max(1, Math.min(PROBE_MS, SESSION_MS - (performance.now() - window.monotonic))));
    const transportError = error => {
      // Fixed enums only: no peer-controlled OpenSSL/parser/error text escapes.
      if (probe.id === "directSidecar" && error.code === "ECONNREFUSED") finish("CONNECTION_REFUSED", "ECONNREFUSED");
      else if (TLS_ALERTS.has(error.code)) finish("TLS_ALERT", error.code);
      else finish("TRANSPORT_ERROR", "UNCLASSIFIED_TRANSPORT_ERROR");
    };
    const captureSocket = () => {
      result.sourceAddress = socket.localAddress ?? null; result.peerAddress = socket.remoteAddress ?? null; result.peerPort = socket.remotePort ?? null;
      if (result.sourceAddress !== options.sourceAddress || result.peerAddress !== options.targetAddress
        || result.peerPort !== (probe.id === "directSidecar" ? options.sidecarPort : options.port)) {
        finish("SOCKET_IDENTITY_MISMATCH", "SOCKET_IDENTITY_MISMATCH"); return false;
      }
      return true;
    };
    try {
      if (probe.id === "directSidecar") {
        socket = net.createConnection({ host: options.targetAddress, port: options.sidecarPort, localAddress: options.sourceAddress });
        socket.once("error", transportError);
        socket.once("connect", () => { if (guard() && captureSocket()) finish("TCP_CONNECTED"); });
        socket.once("close", () => { if (!finished) finish("TRANSPORT_ERROR", "CONNECTION_CLOSED"); });
        return;
      }
      socket = tls.connect({ host: options.targetAddress, port: options.port, localAddress: options.sourceAddress,
        servername: probe.servername, ca: options.serverCaBytes, rejectUnauthorized: true,
        minVersion: "TLSv1.2", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"],
        ...(probe.client ? { cert: options[`${probe.client}CertificateBytes`], key: options[`${probe.client}KeyBytes`] } : {}) });
      socket.once("error", transportError);
      socket.once("close", () => { if (!finished) finish("HTTP_INCOMPLETE", "CONNECTION_CLOSED"); });
      socket.once("secureConnect", () => {
        if (!guard() || !captureSocket()) return;
        try {
          result.tlsAuthorized = socket.authorized === true;
          result.tlsProtocol = socket.getProtocol(); result.alpnProtocol = socket.alpnProtocol || null;
          const peer = socket.getPeerCertificate();
          const cert = new crypto.X509Certificate(peer.raw);
          result.serverLeafSha256 = hash(cert.raw); result.serverSpkiSha256 = spki(cert.publicKey);
          const used = socket.getCertificate();
          result.actualClientLeafSha256 = Buffer.isBuffer(used?.raw) && used.raw.length ? hash(used.raw) : null;
          if (!result.tlsAuthorized || !["TLSv1.2", "TLSv1.3"].includes(result.tlsProtocol)
            || ![null, "http/1.1"].includes(result.alpnProtocol)
            || result.serverSpkiSha256 !== options.approvedServerSpkiSha256
            || result.actualClientLeafSha256 !== (probe.client ? options[`${probe.client}LeafSha256`] : null)) {
            finish("TLS_IDENTITY_MISMATCH", "TLS_IDENTITY_MISMATCH"); return;
          }
          // No HTTP bytes until both actual TLS identities have been checked.
          agent = new http.Agent({ keepAlive: false });
          agent.createConnection = () => socket;
          request = http.request({ hostname: probe.host, port: options.port, method: probe.method, path: probe.path,
            agent, maxHeaderSize: MAX_HEADERS, insecureHTTPParser: false,
            // Public, deliberately invalid proof: satisfy the raw header-shape
            // guard without ever authenticating a business request. Default-off
            // must be independently established by the future operator.
            headers: { Host: probe.host, Connection: "close", Accept: "application/json", "Accept-Encoding": "identity",
              "X-Padlhub-Client-Id": "ingress-probe-unregistered", "X-Padlhub-Key-Id": "ingress-probe-no-key",
              "X-Padlhub-Audience": "ingress-probe-unbound", "X-Padlhub-Timestamp": String(Math.floor(Date.now() / 1000)),
              "X-Padlhub-Nonce": probe.probeId, "Idempotency-Key": crypto.randomUUID(), "X-Correlation-Id": crypto.randomUUID(),
              "X-Padlhub-Signature": "not-a-v2-signature",
              ...(probe.id === "cors" ? { Origin: "https://ingress-probe.invalid" } : {}) } }, res => {
            response = res;
            res.once("error", () => finish("HTTP_INCOMPLETE", "RESPONSE_INCOMPLETE"));
            if (!guard()) return;
            result.httpStatus = res.statusCode;
            const names = res.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
            result.corsHeaderPresent = names.some(name => name.startsWith("access-control-"));
            result.cacheControl = res.headers["cache-control"] === "no-store" ? "no-store" : null;
            if (res.statusCode < 200 || res.statusCode > 599 || new Set(names).size !== names.length
              || res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity"
              || res.headers["transfer-encoding"] && res.headers["transfer-encoding"] !== "chunked"
              || res.headers["content-length"] && (!/^(0|[1-9][0-9]*)$/.test(res.headers["content-length"]) || Number(res.headers["content-length"]) > MAX_BODY)) {
              finish("HTTP_REJECTED", "RESPONSE_HEADERS_REJECTED"); return;
            }
            const bodyHash = crypto.createHash("sha256");
            res.on("data", chunk => {
              if (!guard()) return;
              result.bodyBytes += chunk.length;
              if (result.bodyBytes > MAX_BODY) { finish("HTTP_REJECTED", "RESPONSE_BODY_TOO_LARGE"); return; }
              bodyHash.update(chunk);
            });
            res.once("end", () => {
              if (!guard()) return;
              if (!res.complete || res.rawTrailers.length) { finish("HTTP_INCOMPLETE", "RESPONSE_INCOMPLETE"); return; }
              result.complete = true; result.bodySha256 = bodyHash.digest("hex"); finish("HTTP_RESPONSE");
            });
          });
          request.once("error", () => finish("HTTP_INCOMPLETE", "RESPONSE_PARSE_OR_TRANSPORT_ERROR"));
          request.once("upgrade", () => finish("HTTP_REJECTED", "RESPONSE_UPGRADE_REJECTED"));
          request.on("information", () => finish("HTTP_REJECTED", "RESPONSE_INFORMATIONAL_REJECTED"));
          request.end();
        } catch { finish("TRANSPORT_ERROR", "TLS_OR_HTTP_OBSERVATION_FAILED"); }
      });
    } catch { finish("TRANSPORT_ERROR", "CONNECTION_SETUP_FAILED"); }
  });
}

export async function collectPartnerNginxTransportObservations(input) {
  const options = prepare(input), window = { monotonic: performance.now(), wall: Date.now() };
  const challenge = crypto.randomBytes(32).toString("hex"), probes = [];
  try {
    for (const id of PARTNER_INGRESS_REQUIRED_PROBES) {
      if (performance.now() - window.monotonic >= SESSION_MS || Date.now() < window.wall || Date.now() - window.wall >= SESSION_MS) fail("NGINX_PROBE_SESSION_EXPIRED");
      probes.push(await observe(plan(id, options, challenge), options, window));
    }
    if (performance.now() - window.monotonic >= SESSION_MS || Date.now() < window.wall || Date.now() - window.wall >= SESSION_MS) fail("NGINX_PROBE_SESSION_EXPIRED");
    return Object.freeze({ state: "NGINX_TRANSPORT_OBSERVATIONS_NOT_INGRESS_PROOF", challenge,
      startedAt: window.wall, completedAt: Date.now(),
      target: { address: options.targetAddress, sourceBindAddress: options.sourceAddress, port: options.port, sidecarPort: options.sidecarPort,
        exactHost: options.exactHost, sharedHost: options.sharedHost }, probes,
      productionVerified: false, deployAuthorized: false, activationAuthorized: false,
      vantage: "UNATTESTED", applicationEvidence: "NOT_COLLECTED", upstreamAdmission: "NOT_COLLECTED" });
  } finally { for (const field of BUFFER_KEYS) options[field].fill(0); }
}
