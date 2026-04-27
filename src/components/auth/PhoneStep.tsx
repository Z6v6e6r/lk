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
      <PhoneInput value={phone} onChange={setPhone} />
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
