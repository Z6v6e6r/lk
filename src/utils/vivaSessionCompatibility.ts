import { AUTH_RUNTIME_KEYCLOAK_BASE, AUTH_RUNTIME_TENANT_KEY } from "../consts/authRuntime.ts";
import { extractJwtPayload, extractJwtStringClaim } from "./vivaAuthJwt.ts";

export type VivaSessionProblem = "invalid_claims" | "missing_openid" | "issuer_mismatch"
  | "client_mismatch" | "tenant_mismatch" | "subject_mismatch";

export const VIVA_REAUTH_MESSAGE = "Войдите заново, чтобы продолжить.";

// Unverified client-side compatibility only. The provider/backend still authorize
// every operation; claims here must never grant access or prove identity.
export function vivaSessionProblem(token: string | null | undefined, previousToken?: string | null): VivaSessionProblem | null {
  const claims = extractJwtPayload(token);
  if (!claims || Array.isArray(claims)) return "invalid_claims";
  if (typeof claims.scope === "string" && !claims.scope.split(/\s+/).includes("openid")) return "missing_openid";
  const expectedIssuer = `${AUTH_RUNTIME_KEYCLOAK_BASE.replace(/\/+$/, "")}/realms/clients`;
  if (typeof claims.iss === "string" && claims.iss !== expectedIssuer) return "issuer_mismatch";
  if (typeof claims.azp === "string" && claims.azp !== "widget") return "client_mismatch";
  const tenant = extractJwtStringClaim(token, ["tenantKey", "tenant_key", "tenant"]);
  if (tenant && tenant !== AUTH_RUNTIME_TENANT_KEY) return "tenant_mismatch";
  const previousSubject = extractJwtStringClaim(previousToken, ["sub"]);
  if (previousSubject && extractJwtStringClaim(token, ["sub"]) !== previousSubject) return "subject_mismatch";
  // A missing scope/tenant claim is unknown, not evidence of a provider refusal.
  return null;
}

export class VivaSessionCompatibilityError extends Error {
  readonly reason: VivaSessionProblem;
  constructor(reason: VivaSessionProblem) {
    super(`VIVA_SESSION_${reason.toUpperCase()}`);
    this.name = "VivaSessionCompatibilityError";
    this.reason = reason;
  }
}

export function assertVivaSessionCompatible(token: string, previousToken?: string | null) {
  const problem = vivaSessionProblem(token, previousToken);
  if (problem) throw new VivaSessionCompatibilityError(problem);
}
