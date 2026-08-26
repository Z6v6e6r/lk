import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export const PRODUCTION_MIGRATION_ID = "legacy-game-command-prerequisites-production-v1";
export const PRODUCTION_APPROVAL_ALGORITHM = "Ed25519";
export const PRODUCTION_APPROVAL_SIGNATURE_SCHEMA_VERSION = 1;
export const PRODUCTION_APPROVAL_DOMAIN = "PadlHub legacy game command production migration approval v1";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

export const canonicalJson = (value) => `${JSON.stringify(stableValue(value))}\n`;
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function assertExactObjectKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields do not match the approved schema`);
  }
}

export function parseCanonicalJson(body, label) {
  let text;
  try {
    text = UTF8_DECODER.decode(body);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (text !== canonicalJson(value)) {
    throw new Error(`${label} must use canonical JSON with one trailing newline`);
  }
  return value;
}

function readRegularFile(filePath, maximumSize, label, { privateFile }) {
  const absolutePath = path.resolve(String(filePath || ""));
  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    const unsafeMode = privateFile ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o022) !== 0;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || unsafeMode
      || stat.size === 0 || stat.size > maximumSize) {
      throw new Error("unsafe");
    }
    return fs.readFileSync(descriptor);
  } catch {
    const visibility = privateFile ? "private" : "non-writable";
    throw new Error(`${label} must be an owned ${visibility} regular file with one link`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readProtectedCanonicalJson(filePath, maximumSize, label) {
  const body = readRegularFile(filePath, maximumSize, label, { privateFile: true });
  return { body, value: parseCanonicalJson(body, label), sha256: sha256(body) };
}

export function readTrustedEd25519PublicKey(filePath) {
  const body = readRegularFile(filePath, 8_192, "Approval public key", { privateFile: false });
  return { body, ...importEd25519PublicKey(body) };
}

function assertCustodianDirectoryChain(filePath, executorUid) {
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid === executorUid || (stat.mode & 0o022) !== 0) {
      throw new Error("Production custody path is writable by the migration executor");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readCustodianFile(filePath, maximumSize, label, executorUid) {
  const absolutePath = path.resolve(String(filePath || ""));
  let descriptor;
  try {
    assertCustodianDirectoryChain(absolutePath, executorUid);
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid === executorUid
      || (stat.mode & 0o222) !== 0 || stat.size === 0 || stat.size > maximumSize) {
      throw new Error("unsafe");
    }
    return fs.readFileSync(descriptor);
  } catch {
    throw new Error(`${label} must be a custodian-owned read-only regular file outside executor control`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readCustodianCanonicalJson(filePath, maximumSize, label, {
  executorUid = typeof process.getuid === "function" ? process.getuid() : -1,
} = {}) {
  const body = readCustodianFile(filePath, maximumSize, label, executorUid);
  return { body, value: parseCanonicalJson(body, label), sha256: sha256(body) };
}

export function assertImmutableProductionSourceCustody(filePaths, {
  executorUid = typeof process.getuid === "function" ? process.getuid() : -1,
} = {}) {
  const uniquePaths = [...new Set(filePaths.map((item) => path.resolve(String(item || ""))))];
  if (uniquePaths.length === 0) throw new Error("Production source custody inventory is empty");
  for (const filePath of uniquePaths) {
    let descriptor;
    try {
      assertCustodianDirectoryChain(filePath, executorUid);
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid === executorUid || (stat.mode & 0o222) !== 0) {
        throw new Error("unsafe");
      }
    } catch {
      throw new Error("Production source must be custodian-owned and read-only outside executor control");
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return true;
}

export function importEd25519PublicKey(body) {
  let key;
  try {
    key = crypto.createPublicKey(body);
  } catch {
    throw new Error("Approval public key must be a valid public key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Approval public key must use Ed25519");
  }
  const canonicalPem = key.export({ type: "spki", format: "pem" });
  const supplied = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!supplied.equals(Buffer.from(canonicalPem))) {
    throw new Error("Approval public key must use canonical SPKI PEM encoding");
  }
  const spki = key.export({ type: "spki", format: "der" });
  return { key, spkiSha256: sha256(spki) };
}

export function validateTrustAnchorManifest(manifest) {
  assertExactObjectKeys(
    manifest,
    ["schemaVersion", "status", "algorithm", "keyId", "publicKeySpkiSha256"],
    "Production trust-anchor manifest",
  );
  if (manifest.schemaVersion !== 1 || manifest.algorithm !== PRODUCTION_APPROVAL_ALGORITHM) {
    throw new Error("Production trust-anchor manifest version or algorithm mismatch");
  }
  if (manifest.status === "UNBOUND") {
    if (manifest.keyId !== "UNBOUND" || manifest.publicKeySpkiSha256 !== "UNBOUND") {
      throw new Error("Unbound production trust-anchor manifest is inconsistent");
    }
    return Object.freeze({ ...manifest });
  }
  if (manifest.status !== "BOUND" || !KEY_ID_PATTERN.test(String(manifest.keyId || ""))
    || !HASH_PATTERN.test(String(manifest.publicKeySpkiSha256 || ""))) {
    throw new Error("Bound production trust-anchor manifest is invalid");
  }
  return Object.freeze({ ...manifest });
}

export function assertProductionTrustAnchorBound(manifest) {
  const validated = validateTrustAnchorManifest(manifest);
  if (validated.status !== "BOUND") {
    throw new Error("Production approval trust anchor is not bound in source");
  }
  return validated;
}

export function buildApprovalSignatureMessage(packetSha256) {
  if (!HASH_PATTERN.test(String(packetSha256 || ""))) {
    throw new Error("Approval packet digest must be a SHA-256 digest");
  }
  return Buffer.concat([
    Buffer.from(PRODUCTION_APPROVAL_DOMAIN, "utf8"),
    Buffer.from([0]),
    Buffer.from(packetSha256, "hex"),
  ]);
}

export function validateApprovalSignatureEnvelope(envelope) {
  assertExactObjectKeys(
    envelope,
    ["schemaVersion", "migrationId", "algorithm", "keyId", "keyFingerprintSha256", "packetSha256", "signatureBase64"],
    "Approval signature envelope",
  );
  if (envelope.schemaVersion !== PRODUCTION_APPROVAL_SIGNATURE_SCHEMA_VERSION
    || envelope.migrationId !== PRODUCTION_MIGRATION_ID
    || envelope.algorithm !== PRODUCTION_APPROVAL_ALGORITHM
    || !KEY_ID_PATTERN.test(String(envelope.keyId || ""))) {
    throw new Error("Approval signature envelope identity mismatch");
  }
  if (!HASH_PATTERN.test(String(envelope.keyFingerprintSha256 || ""))
    || !HASH_PATTERN.test(String(envelope.packetSha256 || ""))) {
    throw new Error("Approval signature envelope digest is invalid");
  }
  if (!BASE64_PATTERN.test(String(envelope.signatureBase64 || ""))) {
    throw new Error("Approval signature must use canonical base64");
  }
  const signature = Buffer.from(envelope.signatureBase64, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== envelope.signatureBase64) {
    throw new Error("Approval signature must be a canonical 64-byte Ed25519 signature");
  }
  return signature;
}

export function verifyProductionApprovalSignature({ packetBody, envelope, publicKeyBody, trustAnchor }) {
  const boundAnchor = assertProductionTrustAnchorBound(trustAnchor);
  const signature = validateApprovalSignatureEnvelope(envelope);
  const packetSha256 = sha256(packetBody);
  if (envelope.packetSha256 !== packetSha256) {
    throw new Error("Approval signature packet digest mismatch");
  }
  if (envelope.keyId !== boundAnchor.keyId
    || envelope.keyFingerprintSha256 !== boundAnchor.publicKeySpkiSha256) {
    throw new Error("Approval signature trust-anchor identity mismatch");
  }
  const publicKey = importEd25519PublicKey(publicKeyBody);
  if (publicKey.spkiSha256 !== boundAnchor.publicKeySpkiSha256) {
    throw new Error("Approval public key fingerprint mismatch");
  }
  if (!crypto.verify(null, buildApprovalSignatureMessage(packetSha256), publicKey.key, signature)) {
    throw new Error("Approval signature verification failed");
  }
  return Object.freeze({
    algorithm: PRODUCTION_APPROVAL_ALGORITHM,
    keyId: boundAnchor.keyId,
    keyFingerprintSha256: boundAnchor.publicKeySpkiSha256,
    packetSha256,
  });
}
