import { useState } from "react";
import { useAuth } from "../../context/authShared";
import { PhoneStep } from "./PhoneStep";
import { CodeStep } from "./CodeStep";

type Step = "phone" | "code";

export function LegacyAuthForm({ onLogin }: { onLogin: () => void }) {
  const { sendCode, login, phone, error, clearError } = useAuth();
  const [step, setStep] = useState<Step>("phone");

  const handleSendCode = async (value: string) => {
    const ok = await sendCode(value, "cascade");
    if (ok) setStep("code");
  };

  const handleVerifyCode = async (code: string) => {
    const ok = await login(phone, code);
    if (ok) onLogin();
  };

  return (
    <div className="auth-wrapper">
      {step === "phone" ? (
        <PhoneStep onSend={handleSendCode} error={error} authPhone={phone} />
      ) : (
        <CodeStep
          phone={phone}
          onVerify={handleVerifyCode}
          onResendSms={() => sendCode(phone, "cascade")}
          onChangePhone={() => { setStep("phone"); clearError(); }}
          error={error}
        />
      )}
    </div>
  );
}
