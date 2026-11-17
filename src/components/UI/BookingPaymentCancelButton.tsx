import { useEffect, useRef, useState } from "react";
import { apiCancelBookingPaymentAttempt, apiFetchProfile } from "../../utils/apiClient";
import { readAuthToken } from "../../utils/authTokenStorage";
import { bookingPaymentCancellation, PAYMENT_CANCELLATION_CLOSED, PAYMENT_CANCELLATION_PAID,
  PAYMENT_CANCELLATION_PENDING, type BookingPaymentTarget, type BookingPaymentCancellationState } from "../../utils/bookingPaymentCancellation";

type Props = {
  target: BookingPaymentTarget | null; actorClientId: string | null | undefined;
  onChange?: () => void; onSettled?: (state: "CLOSED" | "PAID", isCurrent: () => boolean) => void | Promise<void>;
};
export function BookingPaymentCancelButton(props: Props) {
  return <BookingPaymentCancelAction key={JSON.stringify(props.target)} {...props} />;
}
function BookingPaymentCancelAction({ target, actorClientId, onChange, onSettled }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actor, setActor] = useState(actorClientId || null);
  const [profileRetry, setProfileRetry] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const token = readAuthToken();
    if (actorClientId && actor !== actorClientId) setActor(actorClientId);
    if (target && !actor && !actorClientId && token) void apiFetchProfile().then(result => {
      if (mounted.current && readAuthToken() === token) {
        setActor(result.data?.id || null);
        if (result.error || !result.data?.id) setMessage("Не удалось подтвердить профиль для отмены оплаты.");
      }
    }).catch(() => { if (mounted.current) setMessage("Не удалось подтвердить профиль для отмены оплаты."); });
    return () => { mounted.current = false; };
  }, [target, actorClientId, actor, profileRetry]);
  const stored: BookingPaymentCancellationState | null = target && actor
    ? bookingPaymentCancellation().state(target, actor, readAuthToken()) : null;
  if (!target) return null;
  const terminal = stored === "CLOSED" || stored === "PAID";
  const text = message || (stored === "CLOSED" ? PAYMENT_CANCELLATION_CLOSED
    : stored === "PAID" ? PAYMENT_CANCELLATION_PAID : stored === "CLOSING" ? PAYMENT_CANCELLATION_PENDING : null);
  const cancel = async () => {
    if (running.current) return;
    if (!actor) return;
    running.current = true; setBusy(true); setMessage(null);
    const session = readAuthToken();
    try {
      const result = await apiCancelBookingPaymentAttempt(target, actor, () => {
        if (mounted.current && readAuthToken() === session) onChange?.();
      });
      if (!mounted.current || readAuthToken() !== session) return;
      setMessage(result.message);
      if (result.state === "CLOSED" || result.state === "PAID") {
        try { await onSettled?.(result.state, () => mounted.current && readAuthToken() === session); }
        catch { if (mounted.current && readAuthToken() === session) setMessage(`${result.message} Не удалось обновить запись. Обновите страницу.`); }
      }
    } catch {
      if (mounted.current && readAuthToken() === session) setMessage("Не удалось проверить отмену. Проверьте результат текущей попытки.");
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="booking-payment-cancel" aria-busy={busy}>
    {!terminal && <button type="button" className="section-cta section-cta-secondary" disabled={busy || !actor && !message}
      onClick={() => {
        if (!actor) { setMessage(null); setProfileRetry(value => value + 1); return; }
        void cancel();
      }}>{!actor ? message ? "Повторить проверку профиля" : "Проверяем профиль..." : busy ? "Отменяем оплату..." : stored === "CLOSING" ? "Проверить отмену оплаты" : "Отменить оплату"}</button>}
    {text && <p role="status" aria-live="polite">{text}</p>}
  </div>;
}
