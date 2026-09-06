// Synthetic public/private test identities. Never load a user's certificate/key.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export function createPartnerNginxTestCertificates(directory, { sourceLimits = false } = {}) {
  if (typeof sourceLimits !== "boolean") throw new Error("Boolean fixture option required");
  if (fs.existsSync(directory)) throw new Error("New fixture directory required");
  fs.mkdirSync(directory, { mode: 0o700 });
  const openssl = args => execFileSync("openssl", args, { cwd: directory, timeout: 15000, stdio: "pipe" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Local Partner fixture CA", "-keyout", "ca.key", "-out", "ca.crt"]);
  for (const [index, name] of ["server", "client", "other-client", ...(sourceLimits ? ["client-2", "client-3"] : [])].entries()) {
    openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${name}-fixture`, "-keyout", `${name}.key`, "-out", `${name}.csr`]);
    fs.writeFileSync(path.join(directory, `${name}.ext`), name === "server"
      ? "subjectAltName=DNS:fixture.invalid,DNS:shared.invalid\nextendedKeyUsage=serverAuth\n"
      : "extendedKeyUsage=clientAuth\n", { mode: 0o600 });
    openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", String(index + 2), "-days", "1", "-extfile", `${name}.ext`, "-out", `${name}.crt`]);
  }
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Untrusted fixture client", "-keyout", "wrong-client.key", "-out", "wrong-client.crt"]);
  for (const name of fs.readdirSync(directory)) fs.chmodSync(path.join(directory, name), 0o600);
  const clientCertificateBytes = fs.readFileSync(path.join(directory, "client.crt"));
  return {
    scope: "LOCAL_FIXTURE", exactHost: "fixture.invalid", sharedHost: "shared.invalid", now: Date.now(), clientCertificateBytes,
    serverCertificateBytes: fs.readFileSync(path.join(directory, "server.crt")), caCertificateBytes: fs.readFileSync(path.join(directory, "ca.crt")),
    approvedClientSpkiSha256: crypto.createHash("sha256").update(new crypto.X509Certificate(clientCertificateBytes).publicKey.export({ type: "spki", format: "der" })).digest("hex"),
    ...(sourceLimits ? { sourceLimitClients: ["client-2", "client-3"].map(name => {
      const bytes = fs.readFileSync(path.join(directory, `${name}.crt`));
      return { clientCertificateBytes: bytes,
        approvedClientSpkiSha256: crypto.createHash("sha256").update(new crypto.X509Certificate(bytes).publicKey.export({ type: "spki", format: "der" })).digest("hex") };
    }) } : {}),
  };
}
