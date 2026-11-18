import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { LegacyAuthProvider } from '../../context/LegacyAuthProvider';
import { VivaAuthProvider } from '../../context/VivaAuthProvider';
import { AuthContext, useAuth } from '../../context/authShared';
import { resolveConfiguredAuthMode } from '../../utils/authMode';
import { hasRetryablePendingAuthConsents } from '../../utils/authConsents';
import { cancelFastIntent, readFastIntent } from './zeroCheckoutIntent';

const CheckoutAuthEvent = createContext({ pending: false, interactiveIdentity: null as string | null });
export const useCheckoutAuthEvent = () => useContext(CheckoutAuthEvent);

/** Scope interactive-login proof to this checkout, never to a restored auth boolean. */
function CheckoutAuthBridge({ children, intentId, proof }: { children: ReactNode; intentId?: string; proof: RefObject<string | null> }) {
  const auth = useAuth();
  const [pending, setPending] = useState(false);
  const [interactiveIdentity, setIdentity] = useState<string | null>(null);
  const value = useMemo(() => {
    async function interactive(operation: () => Promise<boolean>) {
      proof.current = null; setPending(true);
      try {
        const ok = await operation();
        if (ok && intentId && readFastIntent(intentId) && !hasRetryablePendingAuthConsents()) setIdentity(proof.current);
        return ok;
      } finally { setPending(false); }
    }
    return { ...auth,
      login: (phone: string, code: string) => interactive(() => auth.login(phone, code)),
      verifyPhone: (phone: string, code: string) => interactive(() => auth.verifyPhone(phone, code)),
      logout: () => { if (intentId) cancelFastIntent(intentId); setIdentity(null); auth.logout(); },
    };
  }, [auth, intentId, proof]);
  if (!intentId) return children;
  return <AuthContext.Provider value={value}><CheckoutAuthEvent.Provider value={{ pending, interactiveIdentity }}>{children}</CheckoutAuthEvent.Provider></AuthContext.Provider>;
}

/** Normal auth protocol, without page-wide tracking/idle hooks or new callback routes. */
export function CheckoutAuthProvider({ children, intentId, initialIdentity }: { children: ReactNode; intentId?: string; initialIdentity?: string | null }) {
  const proof = useRef<string | null>(null);
  const verified = useCallback((identity: string | null) => { proof.current = identity; }, []);
  const content = <CheckoutAuthBridge intentId={intentId} proof={proof}>{children}</CheckoutAuthBridge>;
  return resolveConfiguredAuthMode() === 'viva'
    ? <VivaAuthProvider oauthContinuationId={intentId} initialCheckoutIdentity={initialIdentity} onInteractiveSession={intentId ? verified : undefined}>{content}</VivaAuthProvider>
    : <LegacyAuthProvider onInteractiveSession={intentId ? verified : undefined}>{content}</LegacyAuthProvider>;
}
