import { useState } from "react";
import { PhoneInput } from "./PhoneInput";

interface PhoneStepProps {
  onSend: (phone: string) => void;
  authPhone: string | null;
  error: string | null;
}

export function PhoneStep({ onSend, error, authPhone }: PhoneStepProps) {
  const [phone, setPhone] = useState(authPhone ?? "");

  return (
    <div className="auth-card">
      <p className="auth-title">Войти или зарегистрироваться</p>
      {/*<p className="auth-subtitle">
      мы отправим код подтверждения<br/>
      - проверьте сообщение от Telegram Gateway;<br/>
      - проверьте sms сообщение;<br/>
      - если код не приходит, поделитесь своим номером с нашим{' '}
    <a href="https://t.me/Academy_F_padel_bot" target="_blank" rel="noreferrer">
     ботом
  </a>
</p>  */}    <PhoneInput value={phone} onChange={setPhone} />
      <button
        className="auth-btn"
        onClick={() => onSend(phone)}
        disabled={phone.length !== 11}
      >
        Продолжить
      </button>
      {error && <p className="auth-error">{error}</p>}
    </div>
  );
}
