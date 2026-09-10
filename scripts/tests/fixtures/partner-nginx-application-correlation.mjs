// Fixed fixture entrypoint. It is copied only into the owned rehearsal containers.
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson } from "../../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import { parseCanonicalIngressJson } from "../../partner_game_membership_ingress_evidence.mjs";
import { createLocalNginxGenerationSession } from "../../partner_game_membership_nginx_generation.mjs";
import { collectPartnerNginxTransportObservations } from "../../partner_game_membership_nginx_probes.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = () => { throw new Error("NGINX_APPLICATION_CORRELATION_FIXTURE_FAILED"); };
const platform = () => { if (process.platform !== "linux" || process.arch !== "x64" || process.getuid() === 0) fail(); };
const exact = (value, fields) => { if (!value || Object.getPrototypeOf(value) !== Object.prototype || !isDeepStrictEqual(Object.keys(value).sort(), fields.toSorted())) fail(); };
const bounded = (file, maximum = 8192) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > maximum) fail();
    const bytes = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    if (offset !== stat.size) fail(); return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
};

export async function serveLocalNginxGeneration(input, output) {
  platform(); let session, buffer = Buffer.alloc(0), total = 0, count = 0, transport;
  const timer = setTimeout(() => input.destroy(new Error("NGINX_APPLICATION_CORRELATION_DEADLINE")), 90000);
  try {
    for await (const chunk of input) {
      total += chunk.length; if (total > 81920) fail(); buffer = Buffer.concat([buffer, chunk]);
      let end;
      while ((end = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); count++;
        const value = parseCanonicalIngressJson(line, count === 1 ? 16384 : 65536);
        if (count === 1) {
          exact(value, ["baseline", "expected"]);
          session = createLocalNginxGenerationSession({ ...value, logPath: "/out/correlation/access.jsonl" });
          output.write(canonicalJson({ state: "READY_LOCAL_LOG_WINDOW", initialSha256: hash(canonicalJson(value)) }) + "\n");
        } else if (count === 2) transport = value;
        else fail();
      }
    }
    if (buffer.length || count !== 2 || !session) fail();
    const result = session.finish(transport);
    output.write(canonicalJson({ state: "RESULT_LOCAL_LOG_WINDOW", result }) + "\n");
  } finally { clearTimeout(timer); session?.close(); }
}

export async function collectLocalNginxApplicationTransport() {
  platform(); const network = parseCanonicalIngressJson(bounded("/fixture/correlation-network.json", 1024), 1024);
  exact(network, ["peerAddress", "probeAddress"]);
  // Only the two fixture addresses derived by the owned operator. No host/CIDR/port overrides.
  if (!/^(?:172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.2$/.test(network.peerAddress)
    || network.probeAddress !== network.peerAddress.slice(0, -1) + "3") fail();
  const keys = [], namespace = () => hash(fs.readlinkSync("/proc/self/ns/net"));
  const before = namespace();
  try {
    const clientCertificateBytes = bounded("/fixture/client-2.crt"), wrongClientCertificateBytes = bounded("/fixture/client.crt");
    const server = new crypto.X509Certificate(bounded("/fixture/server.crt"));
    const clientKeyBytes = bounded("/fixture/client-2.key"); keys.push(clientKeyBytes);
    const wrongClientKeyBytes = bounded("/fixture/client.key"); keys.push(wrongClientKeyBytes);
    const spki = bytes => hash(new crypto.X509Certificate(bytes).publicKey.export({ type: "spki", format: "der" }));
    const transport = await collectPartnerNginxTransportObservations({ targetAddress: network.peerAddress, sourceAddress: network.probeAddress,
      port: 8443, sidecarPort: 18894, exactHost: "fixture.invalid", sharedHost: "shared.invalid",
      serverCaBytes: bounded("/fixture/ca.crt"), clientCertificateBytes, clientKeyBytes, wrongClientCertificateBytes, wrongClientKeyBytes,
      approvedServerSpkiSha256: hash(server.publicKey.export({ type: "spki", format: "der" })),
      approvedClientSpkiSha256: spki(clientCertificateBytes), approvedWrongClientSpkiSha256: spki(wrongClientCertificateBytes) });
    if (namespace() !== before) fail(); return { transport, networkNamespaceSha256: before };
  } finally { keys.forEach(bytes => bytes.fill(0)); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) fail();
    if (process.argv[2] === "host") await serveLocalNginxGeneration(process.stdin, process.stdout);
    else if (process.argv[2] === "probe") process.stdout.write(canonicalJson(await collectLocalNginxApplicationTransport()) + "\n");
    else fail();
  } catch { process.stderr.write("NGINX_APPLICATION_CORRELATION_FIXTURE_FAILED\n"); process.exitCode = 1; }
}
