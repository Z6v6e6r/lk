import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { checkoutSessionToken, checkoutTransportMatches, resolveCheckoutPhone } from './zeroCheckoutSession';
import { hasRecordedZeroAttempt, hasZeroAttempt, resumeZeroPayment } from './zeroCheckoutPayment';
import { isCheckoutOpen } from './zeroCheckoutMount';
import { isCheckoutReturn } from './zeroCheckoutOffers';

// These offers have an existing backend proof of a closed, unpaid checkout.
const RECOVERABLE_KEYS = ['friendship', 'friendship-two-hours'];
const RETRY_INTERVAL_MS = 30_000;
const CHECK_DEADLINE_MS = 20_000;

/** Reconcile existing purchases only. Never navigate or start a replacement purchase. */
export function usePendingCheckoutReconciliation(offerKeys: readonly string[], enabled: boolean): readonly string[] {
  const auth = useAuth();
  const ready = enabled && auth.isAuthenticated && !auth.isRestoringSession && !auth.isLoading && !auth.needsPhoneVerification;
  const keys = JSON.stringify(RECOVERABLE_KEYS.filter(key => offerKeys.includes(key)));
  const [checking, setChecking] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!ready || keys === '[]' || isCheckoutReturn()) return;
    let alive = true;
    let running = false;
    let lastCheck = -Infinity;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const visible = () => alive && !document.hidden && !isCheckoutOpen();
    const refresh = async () => {
      if (!visible() || running || Date.now() - lastCheck < RETRY_INTERVAL_MS) return;
      const token = checkoutSessionToken();
      if (!token || !checkoutTransportMatches(token)) return;
      const pending = (JSON.parse(keys) as string[]).filter(key => hasRecordedZeroAttempt(key) && hasZeroAttempt(key));
      if (!pending.length) { setChecking([]); return; }
      running = true;
      lastCheck = Date.now();
      setChecking(pending);
      let active = true;
      const current = () => active && visible() && checkoutSessionToken() === token && checkoutTransportMatches(token);
      const expired = new Promise<void>(resolve => {
        deadline = setTimeout(() => { active = false; resolve(); }, CHECK_DEADLINE_MS);
      });
      const reconcile = async () => {
        const phone = await resolveCheckoutPhone(token, true);
        await Promise.all(pending.map(async key => {
          if (!current()) return;
          // The existing adapter validates ownership, receipts and locks. In
          // particular, a restart result is NOT passed to the purchase handler.
          try {
            const result = await resumeZeroPayment(key, phone, current);
            if (!current()) return;
            if (result.status === 'restart' || result.status === 'paid') {
              window.dispatchEvent(new CustomEvent('padlhub:checkout-notice', { detail: result.message }));
            }
          } catch {
            // Failure for one offer must not starve another offer's check.
          }
        }));
      };
      try {
        await Promise.race([reconcile(), expired]);
      } catch {
        // An unavailable/ambiguous confirmation must retain the payment guard.
      } finally {
        active = false;
        clearTimeout(deadline);
        running = false;
        if (alive) setChecking([]); // Re-render after the adapter changed storage.
      }
    };
    const onReturn = () => { void refresh(); };
    const onStorage = () => { setChecking(previous => [...previous]); void refresh(); };
    window.addEventListener('focus', onReturn);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onReturn);
    void refresh();
    return () => {
      alive = false;
      clearTimeout(deadline);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [ready, keys]);

  return ready ? checking : [];
}
