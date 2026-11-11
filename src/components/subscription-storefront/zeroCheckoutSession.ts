import { request } from '../../utils/apiClient';
import { TENANT_KEY } from '../../consts/api_config';
import { authSessionIdentity, sessionIdentityBinding } from '../../utils/authSessionIdentity';
import { resolveConfiguredAuthMode } from '../../utils/authMode';
import { readAuthToken } from '../../utils/authTokenStorage';
import { readVivaAccessToken } from '../../utils/vivaAuthStorage';

export type FastCheckoutSession = { id: string; initialIdentity: string | null; sessionBinding?: string; resume?: boolean };
/** An unrelated legacy cookie is not evidence of a current Viva checkout session. */
export function checkoutSessionToken(): string | null {
  return resolveConfiguredAuthMode() === 'viva' ? readVivaAccessToken() : readAuthToken();
}
export function checkoutSessionIdentity(): string | null {
  return authSessionIdentity(checkoutSessionToken(), resolveConfiguredAuthMode());
}
/** Bind before claim/profile work, including a token swap before the first render. */
export async function verifyFastCheckoutSession(fast: FastCheckoutSession, interactiveIdentity: string | null): Promise<string> {
  const identity = checkoutSessionIdentity(), expected = fast.initialIdentity || interactiveIdentity;
  if (!identity || !checkoutSessionToken() || expected && identity !== expected
    || !expected && !fast.sessionBinding
    || fast.sessionBinding && await sessionIdentityBinding(fast.id, identity) !== fast.sessionBinding
    || checkoutSessionIdentity() !== identity) throw new Error('Аккаунт изменился. Подтвердите покупку в текущем аккаунте.');
  return identity;
}

export function checkoutTransportMatches(token: string | null): boolean { return !!token && readAuthToken() === token; }

/** Read the actor's phone using the same token that authorized this checkout. */
export async function resolveCheckoutPhone(token: string | null, requireTransportMatch = false): Promise<string> {
  if (!token || checkoutSessionToken() !== token || requireTransportMatch && !checkoutTransportMatches(token)) throw new Error('Аккаунт изменился. Войдите заново.');
  const result = await request<{ phone?: string }>(`/end-user/api/v1/${TENANT_KEY}/profile`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}` }, auth: false,
    cache: 'no-store', cacheTtlMs: 0, dedupe: false, retries: 0,
  });
  if (checkoutSessionToken() !== token || requireTransportMatch && !checkoutTransportMatches(token)) throw new Error('Аккаунт изменился. Подтвердите покупку заново.');
  const phone = String(result.data?.phone || '').trim();
  if (result.error || !phone) throw new Error('Не удалось определить номер телефона в профиле');
  return phone;
}
