import { useState } from 'react';
import { useAuth } from '../../context/authShared';
import { PhoneInput } from '../auth/PhoneInput';

/**
 * Self-contained SMS login for the storefront widget.
 *
 * The widget runs on a Tilda page without the cabinet stylesheet, so it reuses
 * the auth context contract (send code + verify code) with its own scoped markup
 * instead of embedding the cabinet `AuthForm` styles.
 */
export function StorefrontLogin({ onCancel }: { onCancel: () => void }) {
  const { sendCode, login, error, clearError, isLoading } = useAuth();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  async function requestCode() {
    setLocalError(null);
    clearError();
    if (phone.replace(/\D/g, '').length < 11) {
      setLocalError('Введите номер телефона в формате +7 (999) 000-00-00');
      return;
    }
    const sent = await sendCode(phone, 'cascade');
    if (sent) setStep('code');
  }

  async function verify(nextCode: string) {
    setLocalError(null);
    clearError();
    if (nextCode.length < 4) {
      setLocalError('Введите код из 4 цифр');
      return;
    }
    await login(phone, nextCode);
  }

  return (
    <form
      className="subscription-login"
      onSubmit={event => {
        event.preventDefault();
        if (step === 'phone') void requestCode();
        else void verify(code);
      }}
    >
      {step === 'phone' ? (
        <>
          <p className="subscription-login__title">Вход по SMS</p>
          <p className="subscription-login__subtitle">
            Введите номер телефона, чтобы получить код подтверждения.
          </p>
          <PhoneInput value={phone} onChange={setPhone} />
          <button type="submit" className="subscription-login__submit" disabled={isLoading}>
            Получить код
          </button>
        </>
      ) : (
        <>
          <p className="subscription-login__title">Подтвердите номер</p>
          <p className="subscription-login__subtitle">
            Мы отправили код из 4 цифр на номер {phone}.
          </p>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={4}
            className="subscription-login__input"
            placeholder="Код из 4 цифр"
            value={code}
            onChange={event => {
              const next = event.target.value.replace(/\D/g, '').slice(0, 4);
              setCode(next);
              if (next.length === 4) void verify(next);
            }}
            disabled={isLoading}
          />
          <button type="submit" className="subscription-login__submit" disabled={isLoading}>
            Войти
          </button>
          <button
            type="button"
            className="subscription-login__resend"
            disabled={isLoading}
            onClick={() => { void requestCode(); }}
          >
            Отправить код снова
          </button>
          <button
            type="button"
            className="subscription-login__resend"
            onClick={() => { clearError(); setLocalError(null); setCode(''); setStep('phone'); }}
          >
            ← Изменить номер
          </button>
        </>
      )}
      {(localError || error) && <p className="subscription-login__error" role="alert">{localError || error}</p>}
      <button type="button" className="subscription-login__resend" onClick={onCancel}>
        Отмена
      </button>
    </form>
  );
}
