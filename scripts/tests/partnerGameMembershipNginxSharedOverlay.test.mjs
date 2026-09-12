import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { after, test } from "node:test";
import { generatePartnerNginxSharedOverlay, hashLocalNginxClosure, verifyLocalNginxSharedOverlayChange } from "../partner_game_membership_nginx_shared_overlay.mjs";
import { generatePartnerNginx124Candidate } from "../partner_game_membership_nginx_candidate.mjs";
import { scanNginxInventoryStructure, scanNginxInventoryStatements } from "../partner_game_membership_nginx_lexical.mjs";
import { verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";
import { createPartnerNginxTestCertificates } from "./fixtures/partner-nginx124-certificates.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "partner-shared-overlay-"));
fs.chmodSync(root, 0o700);
after(() => fs.rmSync(root, { recursive: true, force: true }));
const fixture = createPartnerNginxTestCertificates(path.join(root, "certificates"));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const input = {
  scope: "LOCAL_PREPARATION", exactHost: fixture.exactHost,
  clients: [{ clientId: "synthetic-partner", clientCertificateBytes: fixture.clientCertificateBytes,
    approvedClientSpkiSha256: fixture.approvedClientSpkiSha256 }],
  sourceAddresses: ["198.51.100.10"], generationMarker: "a".repeat(64), now: fixture.now,
  clientCaCertificateBytes: fixture.caCertificateBytes,
  serverCertificateChainBytes: fixture.serverCertificateBytes,
  approvedClientCaSha256: sha(fixture.caCertificateBytes), approvedServerChainSha256: sha(fixture.serverCertificateBytes),
};
const overlay = generatePartnerNginxSharedOverlay(input);
const file = (name, text) => ({ path: name, bytes: Buffer.from(text) });
const baseline = () => [
  file("/etc/nginx/nginx.conf", "events {}\nhttp { include /etc/nginx/mime.types; include /etc/nginx/conf.d/*.conf; include /etc/nginx/sites-enabled/*; include /etc/nginx/modules-enabled/*.conf; }\n"),
  file("/etc/nginx/mime.types", "types { text/plain txt; }\n"),
  file("/etc/nginx/conf.d/existing-a.conf", "map $uri $existing_a { default 0; }\n"),
  file("/etc/nginx/conf.d/existing-b.conf", "log_format existing_b '$status';\n"),
  ...Array.from({ length: 7 }, (_, i) => file(`/etc/nginx/sites-enabled/site-${i}${i > 4 ? ".backup" : ".conf"}`,
    `server { listen 443 ssl; server_name shared-${i}.invalid; include /etc/letsencrypt/options-ssl-nginx.conf; return 404; }\n`)),
  file("/etc/letsencrypt/options-ssl-nginx.conf", "ssl_session_tickets off;\n"),
];
const change = (base = baseline(), own = overlay) => ({ baselineFiles: base,
  candidateFiles: [...base.map(item => ({ ...item, bytes: Buffer.from(item.bytes) })), file(own.path, own.configuration)],
  expectedBaselineSha256: hashLocalNginxClosure(base), overlay: own });
const nest = (name, bytes) => name === "clientCertificateBytes"
  ? { ...input, clients: [{ ...input.clients[0], clientCertificateBytes: bytes }] }
  : { ...input, [name]: bytes };
const rejected = (fn, suffix) => assert.throws(fn, suffix ? new RegExp(`NGINX_SHARED_${suffix}`) : /^PartnerIngressEvidenceError: NGINX_SHARED_/);

test("shared overlay is deterministic, additions-only and has no standalone/shared/default server", () => {
  assert.deepEqual(generatePartnerNginxSharedOverlay(input), overlay);
  const rows = scanNginxInventoryStructure(overlay.configuration);
  const top = rows.filter(row => row.context.length === 0);
  assert.deepEqual([...new Set(top.map(row => row.words[0].value))].sort(), ["limit_conn_zone", "limit_req_zone", "log_format", "map", "server"]);
  assert.equal(top.filter(row => row.words[0].value === "server").length, 1);
  assert.equal(rows.filter(row => row.words[0].value === "server_name").length, 1);
  assert.doesNotMatch(overlay.configuration, /default_server|shared\.invalid|worker_processes|^http \{|^events \{|^pid |^\s*include |^\s*load_module /m);
  assert.equal(overlay.path, "/etc/nginx/conf.d/partner-game-membership-api-v02.conf");
  assert.equal(overlay.configSha256, sha(overlay.configuration));
});

test("route and rate expressions match the existing fixture policy with a separate namespace", () => {
  const legacy = generatePartnerNginx124Candidate(fixture).configuration;
  const routes = text => text.split("\n").map(line => line.trim()).filter(line => /^"~\^(POST|DELETE|GET):/.test(line));
  assert.deepEqual(routes(overlay.configuration), routes(legacy));
  const limits = text => text.split("\n").map(line => line.trim()).filter(line => /^limit_(?:req|conn)(?:_zone|_status)? /.test(line));
  // Zones now key on the certificate-derived client identity, so the comparison keeps the
  // legacy text for the two source-based zones and accepts the bound identity for the rest.
  assert.deepEqual(limits(overlay.configuration.replaceAll("pgm_v02_cert_client", "partner_client").replaceAll("pgm_v02", "partner")), limits(legacy));
  assert.match(overlay.configuration, /proxy_pass http:\/\/127\.0\.0\.1:18894;/);
  assert.match(overlay.configuration, /proxy_next_upstream off;/);
  assert.match(overlay.configuration, /proxy_request_buffering off;/);
  assert.match(overlay.configuration, /map \$ssl_client_escaped_cert \$pgm_v02_cert_client \{ default ""; "~\^[^"]+" "synthetic-partner"; \}/);
  assert.match(overlay.configuration, /map "\$pgm_v02_cert_client:\$http_x_padlhub_client_id" \$pgm_v02_client_bound \{ default 0; "synthetic-partner:synthetic-partner" 1; \}/);
  assert.match(overlay.configuration, /if \(\$pgm_v02_client_bound = 0\) \{ return 403; \}/);
});

test("every named map, limiter and log format uses only the reserved namespace", () => {
  for (const row of scanNginxInventoryStructure(overlay.configuration)) {
    const values = row.words.map(word => word.value);
    if (values[0] === "map") assert.match(values[2], /^\$pgm_v02_/);
    if (values[0] === "log_format") assert.equal(values[1], "pgm_v02_audit");
    if (/^limit_(req|conn)_zone$/.test(values[0])) assert.match(values[2], /^zone=pgm_v02_/);
  }
});

test("audit fields do not include body, URI, IP, caller IDs, DN, certificates or security headers", () => {
  const log = overlay.configuration.split("\n").find(line => line.startsWith("log_format "));
  assert.doesNotMatch(log, /\$request(?:[" ]|_uri|_body)|\$remote_addr|\$http_|\$ssl_client_(?:s_dn|escaped_cert|cert)|synthetic-partner/);
  assert.match(log, /"worker":"\$pid"/);
  assert.match(log, new RegExp(input.generationMarker));
  assert.match(overlay.configuration, /error_log \/dev\/null crit;/);
});

test("several clients are admitted only through their own exact leaf and never through a shared bucket", () => {
  // Two distinct leaves from the same CA, each bound to its own client id: the generated
  // maps must stay pairwise, so a client can never present another client's certificate or
  // claim another client's id.
  const otherBytes = fs.readFileSync(path.join(root, "certificates/other-client.crt"));
  const secondClient = { clientId: "second-partner", clientCertificateBytes: otherBytes,
    approvedClientSpkiSha256: crypto.createHash("sha256")
      .update(new crypto.X509Certificate(otherBytes).publicKey.export({ type: "spki", format: "der" })).digest("hex") };
  const multi = generatePartnerNginxSharedOverlay({ ...input, clients: [{ ...input.clients[0] }, secondClient] });
  // One leaf can never be reused for a second client id.
  rejected(() => generatePartnerNginxSharedOverlay({ ...input, clients: [{ ...input.clients[0] },
    { ...input.clients[0], clientId: "second-partner" }] }), "INPUT_INVALID");
  assert.equal(multi.configuration.match(/\$pgm_v02_cert_client \{/g).length, 1);
  assert.match(multi.configuration, /map "\$pgm_v02_cert_client:\$http_x_padlhub_client_id" \$pgm_v02_client_bound \{ default 0; (?:[^}]*)"synthetic-partner:synthetic-partner" 1; (?:[^}]*)"second-partner:second-partner" 1; (?:[^}]*)\}/);
  assert.deepEqual(multi.clients.map(client => client.clientId), ["synthetic-partner", "second-partner"]);
});

test("public leaf pin plus CA verification, exact Host/SNI and explicit address allowlist remain mandatory", () => {
  assert.match(overlay.configuration, /ssl_verify_client on;/);
  assert.match(overlay.configuration, /ssl_early_data off;/);
  assert.match(overlay.configuration, /ssl_session_cache off;/);
  assert.ok(overlay.configuration.includes(encodeURIComponent(input.clients[0].clientCertificateBytes.toString())));
  assert.match(overlay.configuration, /if \(\$ssl_server_name != "fixture.invalid"\)/);
  assert.match(overlay.configuration, /if \(\$http_host != "fixture.invalid"\)/);
  assert.match(overlay.configuration, /allow 198\.51\.100\.10;\n\s*deny all;/);
  assert.match(overlay.configuration, /limit_req_dry_run off;/);
  assert.match(overlay.configuration, /limit_conn_dry_run off;/);
  assert.match(overlay.configuration, /satisfy all;/);
  assert.doesNotMatch(overlay.configuration, /\$ssl_client_fingerprint|real_ip_header|set_real_ip_from|allow all;/);
});

for (const [name, delta] of Object.entries({
  productionFlag: { scope: "PRODUCTION" }, wildcard: { exactHost: "*.invalid" }, uppercase: { exactHost: "FIXTURE.invalid" },
  injection: { exactHost: "fixture.invalid; include /etc/passwd;" }, clientInjection: { clientId: "a\";return 200;" },
  markerInjection: { generationMarker: "$request_id" }, noSources: { sourceAddresses: [] }, broadSource: { sourceAddresses: ["0.0.0.0/0"] },
  unspecifiedSource: { sourceAddresses: ["0.0.0.0"] }, duplicateSource: { sourceAddresses: ["198.51.100.1", "198.51.100.1"] },
  injectedSource: { sourceAddresses: ["198.51.100.1; allow all"] }, invalidTime: { now: NaN },
  filename: { path: "/etc/nginx/nginx.conf" }, override: { configuration: "server {}" }, deploy: { deployAuthorized: true },
  snapshot: { productionSnapshot: {} }, workerCount: { workerCount: 4 },
})) test(`renderer rejects ${name}`, () => rejected(() => generatePartnerNginxSharedOverlay({ ...input, ...delta })));

test("closed input rejects symbol keys, accessors, sparse arrays and hidden array extras", () => {
  rejected(() => generatePartnerNginxSharedOverlay({ ...input, [Symbol("unknown")]: true }));
  rejected(() => generatePartnerNginxSharedOverlay({ ...input, get exactHost() { throw new Error("must not run"); } }));
  rejected(() => generatePartnerNginxSharedOverlay({ ...input, sourceAddresses: Array(1) }));
  const sources = ["198.51.100.1"]; Object.defineProperty(sources, "hidden", { value: true });
  rejected(() => generatePartnerNginxSharedOverlay({ ...input, sourceAddresses: sources }));
});

test("valid indexed data cannot hide a custom prototype or inherited iterator injection", () => {
  let invoked = false;
  class InjectedArray extends Array {
    *[Symbol.iterator]() { invoked = true; yield "198.51.100.10; allow all; #"; }
  }
  const subclass = new InjectedArray("198.51.100.10");
  const custom = ["198.51.100.10"];
  Object.setPrototypeOf(custom, { ...Array.prototype, [Symbol.iterator]: InjectedArray.prototype[Symbol.iterator] });
  for (const sourceAddresses of [subclass, custom]) rejected(() => generatePartnerNginxSharedOverlay({ ...input, sourceAddresses }), "INPUT_INVALID");
  const closure = new InjectedArray(...baseline());
  rejected(() => hashLocalNginxClosure(closure), "INPUT_INVALID");
  rejected(() => verifyLocalNginxSharedOverlayChange({ ...change(), candidateFiles: closure }), "INPUT_INVALID");
  assert.equal(invoked, false);
});

test("certificate validation and rendering cannot observe different caller Buffer methods", () => {
  let invoked = false;
  const source = { clientCertificateBytes: fixture.clientCertificateBytes, clientCaCertificateBytes: fixture.caCertificateBytes,
    serverCertificateChainBytes: fixture.serverCertificateBytes };
  for (const name of Object.keys(source)) {
    const bytes = Buffer.from(source[name]);
    bytes.toString = () => { invoked = true; return fixture.clientCertificateBytes.toString(); };
    rejected(() => generatePartnerNginxSharedOverlay(nest(name, bytes)), "PUBLIC_CERTIFICATE_INVALID");
    const altered = Buffer.from(source[name]); Object.setPrototypeOf(altered, Object.create(Buffer.prototype));
    rejected(() => generatePartnerNginxSharedOverlay(nest(name, altered)), "PUBLIC_CERTIFICATE_INVALID");
  }
  assert.equal(invoked, false);
});

for (const key of ["approvedClientSpkiSha256", "approvedClientCaSha256", "approvedServerChainSha256"])
  test(`certificate mismatch: ${key}`, () => rejected(() => generatePartnerNginxSharedOverlay(key === "approvedClientSpkiSha256"
    ? { ...input, clients: [{ ...input.clients[0], [key]: "0".repeat(64) }] }
    : { ...input, [key]: "0".repeat(64) }), "CERTIFICATE_PIN_MISMATCH"));

test("certificate admission rejects other SAN, expired/future cert, wrong role and unknown CA", () => {
  for (const delta of [{ exactHost: "partner.example.com" }, { now: input.now + 2 * 86400000 }, { now: input.now - 2 * 86400000 },
    nest("clientCertificateBytes", Buffer.from(fixture.serverCertificateBytes)),
    { serverCertificateChainBytes: fixture.clientCertificateBytes },
    nest("clientCertificateBytes", fs.readFileSync(path.join(root, "certificates/wrong-client.crt")))]) rejected(() => generatePartnerNginxSharedOverlay({ ...input, ...delta }));
});

test("certificate parsing rejects private bytes, duplicate chain and trailing noncertificate input", () => {
  const privateSentinel = ["-----BEGIN", "PRIVATE KEY-----\nSYNTHETIC_PRIVATE_SENTINEL"].join(" ");
  for (const key of ["clientCertificateBytes", "clientCaCertificateBytes", "serverCertificateChainBytes"]) {
    assert.throws(() => generatePartnerNginxSharedOverlay({ ...input, [key]: Buffer.from(privateSentinel) }), error => {
      assert.match(error.code, /^NGINX_SHARED_/); assert.ok(!String(error).includes("SYNTHETIC_PRIVATE_SENTINEL")); return true;
    });
  }
  const chain = Buffer.concat([fixture.serverCertificateBytes, fixture.caCertificateBytes, fixture.caCertificateBytes]);
  rejected(() => generatePartnerNginxSharedOverlay({ ...input, serverCertificateChainBytes: chain, approvedServerChainSha256: sha(chain) }), "CERTIFICATE_CHAIN_INVALID");
  rejected(() => generatePartnerNginxSharedOverlay({ ...input, serverCertificateChainBytes: Buffer.concat([fixture.serverCertificateBytes, Buffer.from("secret")]) }));
});

test("one source-owned overlay preserves all twelve files including backups, without issuing live proof", () => {
  const args = change(), original = args.baselineFiles.map(item => Buffer.from(item.bytes));
  const result = verifyLocalNginxSharedOverlayChange(args);
  assert.equal(result.preservedFileCount, 12); assert.equal(result.addedFileCount, 1);
  assert.equal(result.baselineSha256, args.expectedBaselineSha256); assert.equal(result.overlaySha256, overlay.configSha256);
  assert.deepEqual(args.baselineFiles.map(item => item.bytes), original);
  for (const key of ["productionVerified", "deployAuthorized", "activationAuthorized"]) {
    assert.equal(overlay[key], false); assert.equal(result[key], false);
  }
  assert.equal(result.filesystemCustody, "NOT_CHECKED"); assert.equal(result.workerGeneration, "NOT_OBSERVED");
  assert.throws(() => verifyPartnerProductionIngress(result), /UNSUPPORTED_INGRESS_ADAPTER/);
});

test("source-owned overlay cannot be replaced by a cloned, modified or caller-invented draft", () => {
  for (const value of [{ ...overlay }, { ...overlay, configuration: "server {}" }, {}, null]) rejected(() => verifyLocalNginxSharedOverlayChange({ ...change(), overlay: value }), "SOURCE_OWNED_OVERLAY_REQUIRED");
  assert.ok(Object.isFrozen(overlay)); assert.ok(Object.isFrozen(overlay.unresolvedControls));
});

for (const name of ["changedSharedVhost", "deletedBackup", "extraFile", "modifiedOverlay", "noOverlay", "wrongPin", "alreadyPresent"])
  test(`preservation refuses ${name}`, () => {
    const args = change();
    if (name === "changedSharedVhost") args.candidateFiles[4].bytes = Buffer.from("server { return 200; }");
    if (name === "deletedBackup") args.candidateFiles.splice(9, 1);
    if (name === "extraFile") args.candidateFiles.push(file("/etc/nginx/conf.d/extra.conf", "server {}"));
    if (name === "modifiedOverlay") args.candidateFiles.at(-1).bytes = Buffer.from(overlay.configuration + "server {}\n");
    if (name === "noOverlay") args.candidateFiles.pop();
    if (name === "wrongPin") args.expectedBaselineSha256 = "0".repeat(64);
    if (name === "alreadyPresent") { args.baselineFiles.push(file(overlay.path, "server {}")); args.expectedBaselineSha256 = hashLocalNginxClosure(args.baselineFiles); }
    rejected(() => verifyLocalNginxSharedOverlayChange(args));
  });

for (const [name, text] of Object.entries({
  mapCollision: "map $uri $pgm_v02_route { default 0; }", escapedMapCollision: "map $uri $pgm\\_v02_route { default 0; }",
  zoneCollision: "limit_req_zone $uri zone=pgm_v02_client_rate:1m rate=2r/s;", logCollision: "log_format pgm_v02_audit '$status';",
  hostCollision: "server { server_name fixture.invalid; }", regexHost: "server { server_name ~^unknown.*$; }",
  wildcardHost: "server { server_name *.invalid; }", quotedInclude: '"include" /etc/nginx/mime.types;',
  unknownInclude: "include /etc/nginx/conf.d/unknown.conf;", secretInclude: "include /etc/nginx/credentials.env;",
  unsupportedGlob: "include /etc/nginx/other/*.conf;", recursiveInclude: "include /etc/nginx/nginx.conf;",
})) test(`baseline rejects ${name}`, () => {
  const base = baseline(); base[2].bytes = Buffer.from(text); rejected(() => verifyLocalNginxSharedOverlayChange(change(base)));
});

test("comment text is not a namespace declaration; quoted regex braces retain lexical context", () => {
  const base = baseline(); base[2].bytes = Buffer.from("# pgm_v02 is only a comment\nmap $uri $existing { ~^/[^/?#]+$ yes; }\n");
  assert.equal(verifyLocalNginxSharedOverlayChange(change(base)).preservedFileCount, 12);
  const text = 'http { map $uri $value { "~^/[a-z]{1,3}$" yes; } include /etc/nginx/conf.d/*.conf; }';
  const rows = scanNginxInventoryStructure(text);
  assert.deepEqual(rows.find(row => row.words[0].value === "include").context, ["http"]);
  assert.deepEqual(rows.filter(row => !row.block).map(row => row.words), scanNginxInventoryStatements(text));
});

test("http include must really belong to the entrypoint http context", () => {
  const base = baseline(); base[0].bytes = Buffer.from("stream { include /etc/nginx/conf.d/*.conf; }\n");
  rejected(() => verifyLocalNginxSharedOverlayChange(change(base)), "HTTP_INCLUDE_NOT_PROVEN");
});

test("overlay loading has exactly one edge in the root http context, never repeated or nested", () => {
  for (const index of [0, 2, 4, 11]) {
    const base = baseline();
    if (index === 0) base[0].bytes = Buffer.from(base[0].bytes.toString().replace("http {", "http { include /etc/nginx/conf.d/*.conf;"));
    else base[index].bytes = Buffer.concat([base[index].bytes, Buffer.from("include /etc/nginx/conf.d/*.conf;")]);
    rejected(() => verifyLocalNginxSharedOverlayChange(change(base)), "HTTP_INCLUDE_NOT_PROVEN");
  }
});

test("applicable inherited realip is refused through direct and nested http include contexts", () => {
  for (const directive of ["set_real_ip_from 0.0.0.0/0;", "real_ip_header X-Forwarded-For;", '"real_ip_recursive" on;']) {
    for (const level of ["root", "conf", "nested", "shared"]) {
      const base = baseline();
      if (level === "root") base[0].bytes = Buffer.from(base[0].bytes.toString().replace("http {", `http { ${directive}`));
      if (level === "conf") base[2].bytes = Buffer.from(directive);
      if (level === "nested") {
        base[2].bytes = Buffer.from("include /etc/nginx/options.conf;");
        base.push(file("/etc/nginx/options.conf", directive));
      }
      if (level === "shared") {
        // Visit the same file first under server and then http: dedup must not
        // suppress the second, applicable inherited-context check.
        base[11].bytes = Buffer.from(directive);
        base[0].bytes = Buffer.from(base[0].bytes.toString().replace("include /etc/nginx/modules-enabled/*.conf;", "include /etc/letsencrypt/options-ssl-nginx.conf;"));
      }
      rejected(() => verifyLocalNginxSharedOverlayChange(change(base)), "INHERITED_REALIP_UNSUPPORTED");
    }
  }
});

test("realip scoped only to an unchanged sibling server is not inherited by the new server", () => {
  const base = baseline(); base[11].bytes = Buffer.from("set_real_ip_from 198.51.100.20; real_ip_header X-Forwarded-For;");
  assert.equal(verifyLocalNginxSharedOverlayChange(change(base)).preservedFileCount, 12);
});

test("closure rejects missing, duplicate, unsafe paths, oversize and invalid UTF8 without raw contents", () => {
  const invalid = [[], [file("/etc/nginx/../secret", "x")], [...baseline(), baseline()[0]],
    [...baseline(), file("/etc/nginx/private.key", "SYNTHETIC_PRIVATE_SENTINEL")],
    baseline().map((item, i) => i ? item : { ...item, bytes: Buffer.alloc(131073, 65) }),
    baseline().map((item, i) => i ? item : { ...item, bytes: Buffer.from([255]) })];
  for (const value of invalid) assert.throws(() => hashLocalNginxClosure(value), error => {
    assert.match(error.code, /^NGINX_SHARED_/); assert.ok(!String(error).includes("SYNTHETIC_PRIVATE_SENTINEL")); return true;
  });
});

test("unreachable files and caller-supplied worker/application claims are not proof", () => {
  const base = [...baseline(), file("/etc/nginx/orphan.conf", "server {}")];
  rejected(() => verifyLocalNginxSharedOverlayChange(change(base)), "UNREACHABLE_BASELINE_FILE");
  for (const key of ["workers", "before", "after", "applied", "productionVerified", "reloadReceipt", "operator"]) {
    rejected(() => verifyLocalNginxSharedOverlayChange({ ...change(), [key]: true }), "INPUT_INVALID");
  }
});
