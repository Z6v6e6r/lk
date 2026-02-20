import { useState } from "react";
import { useCountdown } from "../../hooks/useCountdown";
import resendImg from "../../assets/resend.png";

interface CodeStepProps {
  phone: string;
  onVerify: (code: string) => void;
  onResendSms: () => void;
  onChangePhone: () => void;
  error: string | null;
}

export function CodeStep({ phone, onVerify, onResendSms, onChangePhone, error }: CodeStepProps) {
  const [code, setCode] = useState("");
  const [isResending, setIsResending] = useState(false);
  const { timeLeft, reset } = useCountdown(90);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, "").slice(0, 4);
    setCode(val);
    if (val.length === 4) { onVerify(val); setCode(""); }
  };

  const handleResend = async () => {
    setIsResending(true);
    await onResendSms();
    reset();
    setIsResending(false);
  };

  const timeStr = `${Math.floor(timeLeft / 60)}:${(timeLeft % 60).toString().padStart(2, "0")}`;

  return (
    <div className="auth-card">
      <p className="auth-title">Введите код</p>
      <div className="resend-row">
        <input
          type="tel"
          inputMode="numeric"
          maxLength={4}
          value={code}
          onChange={handleCodeChange}
          placeholder="Код из 4 цифр"
          className="auth-input"
        />
        {timeLeft <= 0 && (
          <button onClick={handleResend} disabled={isResending} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <img src={resendImg} className="resend-img" alt="Отправить снова" />
          </button>
        )}
      </div>
      <p className="auth-subtitle">
        Код отправлен по номеру +{phone}<br/> Проверьте <a href="https://t.me/VerificationCodes" target="_blank" rel="noreferrer">Telegram</a> или СМС сообщения.{"\n"}<br/><br/> Код действует {timeStr}<br/><br/>Если код не приходит, поделитесь номером с нашим{' '}
          <a href="https://t.me/Academy_F_padel_bot" target="_blank" rel="noreferrer">ботом</a> и запросите код повторно.
      </p>
      
      {error && <p className="auth-error">{error}</p>}
      <a className="auth-link" onClick={onChangePhone}>← Изменить номер</a>
    </div>
  );
}
