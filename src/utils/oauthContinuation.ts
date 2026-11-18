import { sessionIdentityBinding } from './authSessionIdentity.ts';
/** Opt-in, same-tab continuation receipt. No token, phone or payment data. */
export const OAUTH_CONTINUATION_KEY = 'padlhub_oauth_continuation_v1';
export const OAUTH_RECEIPT_KEY = 'padlhub_oauth_receipt_v1';
const TTL = 10 * 60_000;
export type OAuthContinuation = { kind: 'zero-checkout'; id: string; createdAt: number; expiresAt: number; returnPath: string; initialBinding?: string };
type Armed = OAuthContinuation & { state?: string };
export const continuationIdValid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export function continuationPath(href = window.location.href): string {
  const url = new URL(href);
  if (url.origin !== window.location.origin || url.username || url.password) throw new Error('Invalid continuation origin');
  return url.origin + url.pathname;
}
function valid(value: unknown): value is Armed {
  if (!value || typeof value !== 'object') return false;
  const v = value as Armed, age = Date.now() - v.createdAt;
  return v.kind === 'zero-checkout' && continuationIdValid(v.id) && Number.isSafeInteger(v.createdAt)
    && Number.isSafeInteger(v.expiresAt) && v.expiresAt === v.createdAt + TTL && age >= 0 && age < TTL
    && typeof v.returnPath === 'string' && continuationPath(v.returnPath) === v.returnPath;
}
function read(key: string): unknown { try { return JSON.parse(window.sessionStorage.getItem(key) || 'null'); } catch { return null; } }
function save(key: string, value: unknown) {
  const raw = JSON.stringify(value); window.sessionStorage.setItem(key, raw);
  if (window.sessionStorage.getItem(key) !== raw) throw new Error('Continuation storage unavailable');
}
export function armOAuthContinuation(value: OAuthContinuation) {
  if (!valid(value) || value.returnPath !== continuationPath()) throw new Error('Invalid continuation');
  save(OAUTH_CONTINUATION_KEY, value);
}
export function hasArmedOAuthContinuation(id: string, state?: string): boolean {
  try { const value = read(OAUTH_CONTINUATION_KEY); return valid(value) && value.id === id && (!state || value.state === state) && value.returnPath === continuationPath(); }
  catch { return false; }
}
/** Called only by the opt-in checkout provider before the existing PKCE redirect. */
export function bindOAuthContinuation(id: string | undefined, state: string, returnTo: string, initialBinding = 'guest'): OAuthContinuation | undefined {
  if (!id) return;
  const armed = read(OAUTH_CONTINUATION_KEY);
  if (!valid(armed) || armed.id !== id || armed.returnPath !== continuationPath(returnTo)
    || initialBinding !== 'guest' && !/^[a-f0-9]{64}$/.test(initialBinding)
    || armed.initialBinding && armed.initialBinding !== initialBinding) return;
  const bound = { ...armed, state, initialBinding }; save(OAUTH_CONTINUATION_KEY, bound);
  return { kind: bound.kind, id: bound.id, createdAt: bound.createdAt, expiresAt: bound.expiresAt, returnPath: bound.returnPath, initialBinding };
}
/** Invoke only after verified OAuth state + successful code exchange + normal consent sync. */
export async function completeOAuthContinuation(value: OAuthContinuation | undefined, state: string, returnTo: string, identity: string | null): Promise<boolean> {
  if (!value || !identity) return false;
  try {
    const armed = read(OAUTH_CONTINUATION_KEY);
    if (!valid(value) || !valid(armed) || armed.id !== value.id || armed.state !== state
      || armed.createdAt !== value.createdAt || armed.returnPath !== value.returnPath
      || !value.initialBinding || value.initialBinding !== armed.initialBinding
      || value.returnPath !== continuationPath(returnTo)) return false;
    const identityBinding = await sessionIdentityBinding(value.id, identity);
    if (value.initialBinding !== 'guest' && value.initialBinding !== identityBinding) return false;
    const current = read(OAUTH_CONTINUATION_KEY);
    if (!valid(current) || current.id !== armed.id || current.state !== state || current.initialBinding !== value.initialBinding) return false;
    save(OAUTH_RECEIPT_KEY, { ...value, state, identityBinding, verifiedAt: Date.now() }); return true;
  } catch { return false; } // Authentication itself is not broken by optional continuation storage.
}
export function takeOAuthContinuation(id: string): string | null {
  try {
    const receipt = read(OAUTH_RECEIPT_KEY) as Armed & { verifiedAt?: number; identityBinding?: string };
    const armed = read(OAUTH_CONTINUATION_KEY);
    if (typeof receipt?.identityBinding !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.identityBinding) || !valid(receipt) || !valid(armed) || receipt.id !== id || armed.id !== id
      || !receipt.state || receipt.state !== armed.state || receipt.returnPath !== armed.returnPath
      || !receipt.initialBinding || receipt.initialBinding !== armed.initialBinding
      || receipt.initialBinding !== 'guest' && receipt.initialBinding !== receipt.identityBinding
      || receipt.createdAt !== armed.createdAt || receipt.returnPath !== continuationPath()
      || typeof receipt.verifiedAt !== 'number' || receipt.verifiedAt < receipt.createdAt || receipt.verifiedAt > Date.now()) return null;
    clearOAuthContinuation(id); return receipt.identityBinding;
  } catch { return null; }
}
export function clearOAuthContinuation(id: string) {
  for (const key of [OAUTH_CONTINUATION_KEY, OAUTH_RECEIPT_KEY]) {
    const value = read(key) as { id?: unknown } | null;
    if (value?.id === id) window.sessionStorage.removeItem(key);
  }
}
