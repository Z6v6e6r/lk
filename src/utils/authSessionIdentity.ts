import { extractJwtStringClaim } from './vivaAuthJwt.ts';

/** Comparison only, never an auth grant; unknown/opaque sessions require confirmation. */
export function authSessionIdentity(token: string | null | undefined, mode: 'viva' | 'legacy'): string | null {
  const sub = extractJwtStringClaim(token, ['sub']);
  if (!sub) return null;
  return JSON.stringify([mode, extractJwtStringClaim(token, ['iss']) || '', extractJwtStringClaim(token, ['azp']) || '', extractJwtStringClaim(token, ['tenantKey', 'tenant_key']) || '', sub]);
}
export async function sessionIdentityBinding(intentId: string, identity: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(intentId + '\n' + identity));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
