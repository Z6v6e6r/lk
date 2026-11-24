import { createHash, createPublicKey, verify } from "node:crypto";

const route = "/lk/integrations/v1/game-create-schedule";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const claimKeys = [
  "actor_token_expires_at", "actor_token_sha256", "aud", "caller", "contract_version",
  "correlation_id", "exp", "iat", "iss", "jti", "method", "nbf", "path", "provider",
  "query_sha256", "scope", "sid", "sub", "tenant_id", "tenant_key",
].sort().join(",");
const decode = (part) => {
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) throw Error("Invalid delegation encoding");
  return bytes;
};

export function createScheduleDelegationVerifier(env) {
  const issuer = env.LK2_BOOKED_OPERATION_DELEGATION_ISSUER;
  const audience = env.LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE;
  const keyId = env.LK2_BOOKED_OPERATION_DELEGATION_KEY_ID;
  const pem = env.LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM?.replace(/\\n/g, "\n");
  if (
    !/^[!-~]{1,512}$/.test(issuer ?? "") ||
    !/^[!-~]{1,256}$/.test(audience ?? "") ||
    !/^[A-Za-z0-9._:-]{3,64}$/.test(keyId ?? "") ||
    !pem?.startsWith("-----BEGIN PUBLIC KEY-----")
  ) throw Error("Invalid schedule delegation configuration");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048)
    throw Error("Invalid schedule delegation key");

  return ({ delegation, url, bearer, correlationId, now = Date.now() }) => {
    if (typeof delegation !== "string" || delegation.length > 4096) return false;
    try {
      const parts = delegation.split(".");
      if (parts.length !== 3) return false;
      const [headerBytes, claimBytes, signature] = parts.map(decode);
      const header = JSON.parse(headerBytes);
      if (
        Object.keys(header).length !== 3 ||
        header.alg !== "RS256" ||
        header.typ !== "phub-game-create-schedule+jwt" ||
        header.kid !== keyId ||
        !verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), key, signature)
      ) return false;
      const claims = JSON.parse(claimBytes);
      const second = Math.floor(now / 1000);
      const valid = (
        Object.keys(claims).sort().join(",") === claimKeys &&
        claims.iss === issuer && claims.aud === audience &&
        claims.contract_version === 1 && claims.caller === "lk2-api" && claims.provider === "VIVA" &&
        claims.scope === "game-create.schedule.read" &&
        claims.method === "GET" && claims.path === route && url.pathname === route &&
        claims.tenant_key === "local-padel" &&
        [claims.sub, claims.sid, claims.tenant_id, claims.jti].every((id) =>
          typeof id === "string" && uuid.test(id)) &&
        [claims.iat, claims.exp, claims.actor_token_expires_at].every(Number.isSafeInteger) &&
        claims.nbf === claims.iat &&
        claims.iat <= second + 5 && claims.exp > second &&
        claims.exp > claims.iat && claims.exp - claims.iat <= 60 &&
        claims.exp <= claims.actor_token_expires_at && claims.actor_token_expires_at > second + 15 &&
        claims.correlation_id === correlationId &&
        claims.query_sha256 === digest(url.search.slice(1)) &&
        claims.actor_token_sha256 === digest(bearer.slice(7))
      );
      return valid ? { tenantId: claims.tenant_id, sub: claims.sub } : false;
    } catch {
      return false;
    }
  };
}
