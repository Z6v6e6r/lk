"use strict";

const { createPublicKey, verify } = require("node:crypto");

const ISSUER = "https://kc.vivacrm.ru/realms/clients";
const CERTS_URL = ISSUER + "/protocol/openid-connect/certs";
const KEY_CACHE_MS = 60_000;
const CLIENT_CLAIMS = ["azp", "client_id", "clientId"];
const TENANT_CLAIMS = ["tenantKey", "tenant_key", "tenant"];

const jwtJson = (segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
const supplied = (claims, names) => names.filter((name) => Object.hasOwn(claims, name));

function createVivaAccessVerifier(fetchImpl) {
  let keys = [];
  let refreshAt = 0;
  let loading = null;
  async function readKeys() {
    if (Date.now() < refreshAt) return keys;
    if (!loading) {
      loading = (async () => {
        const response = await fetchImpl(CERTS_URL, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(5_000),
          headers: { Accept: "application/json" },
        });
        if (response.status !== 200) throw new Error("Keycloak signing keys unavailable");
        const body = await response.text();
        if (body.length > 65_536) throw new Error("Unexpected Keycloak signing keys");
        const result = JSON.parse(body);
        if (!Array.isArray(result?.keys) || !result.keys.length || result.keys.length > 32) {
          throw new Error("Unexpected Keycloak signing keys");
        }
        keys = result.keys;
        refreshAt = Date.now() + KEY_CACHE_MS;
        return keys;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  return async (token, { userId, tenantId, clientId }) => {
    try {
      if (typeof token !== "string" || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
      const [headerPart, payloadPart, signature] = token.split(".");
      const header = jwtJson(headerPart);
      const claims = jwtJson(payloadPart);
      const now = Math.floor(Date.now() / 1_000);
      if (header?.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 128
        || ["crit", "b64", "jku", "x5u", "jwk"].some((name) => Object.hasOwn(header, name))) return false;
      if (claims?.iss !== ISSUER || claims.sub !== userId || claims.azp !== clientId || claims.typ !== "Bearer"
        || !Number.isSafeInteger(claims.exp) || claims.exp <= now
        || (Object.hasOwn(claims, "nbf") && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))
        || supplied(claims, CLIENT_CLAIMS).some((name) => claims[name] !== clientId)
        || supplied(claims, TENANT_CLAIMS).some((name) => claims[name] !== tenantId)) return false;

      const matching = (await readKeys()).filter((key) => key?.kid === header.kid);
      if (matching.length !== 1) return false;
      const jwk = matching[0];
      if (jwk.kty !== "RSA" || jwk.use !== "sig" || jwk.alg !== "RS256"
        || ["d", "p", "q", "dp", "dq", "qi", "oth"].some((name) => Object.hasOwn(jwk, name))
        || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify"))) return false;
      const key = createPublicKey({ key: jwk, format: "jwk" });
      if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) return false;
      return verify("RSA-SHA256", Buffer.from(headerPart + "." + payloadPart), key, Buffer.from(signature, "base64url"));
    } catch {
      return false;
    }
  };
}

async function resolveVivaActor(claims, token, clientId, tenantId, verifyAccess) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)
    || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256
    || claims.sub.trim() !== claims.sub
    || Array.from(claims.sub).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  const tenants = supplied(claims, TENANT_CLAIMS);
  if (!tenants.length || tenants.some((name) => claims[name] !== tenantId)) return null;
  const userId = claims.sub;
  const clients = supplied(claims, CLIENT_CLAIMS);
  // An explicit or malformed UserInfo client remains a refusal. Keycloak may omit
  // this claim from UserInfo even though its signed access token carries azp.
  const allowed = clients.length
    ? clients.every((name) => claims[name] === clientId)
    : await verifyAccess(token, { userId, tenantId, clientId });
  return allowed ? { userId, tenantId } : null;
}

module.exports = { createVivaAccessVerifier, resolveVivaActor };
