import { authSessionIdentity, sessionIdentityBinding } from '../../utils/authSessionIdentity';
import { resolveConfiguredAuthMode } from '../../utils/authMode';
import { readAuthToken } from '../../utils/authTokenStorage';
import { readVivaAccessToken } from '../../utils/vivaAuthStorage';

export type FastCheckoutSession = { id: string; initialIdentity: string | null; sessionBinding?: string };
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
