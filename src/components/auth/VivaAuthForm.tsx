import { useEffect, useId, useState, type ReactNode } from "react";
import logoHabBlack from "../../assets/logo hab black.svg";
import resendImg from "../../assets/resend.png";
import vkAuthIcon from "../../assets/vk-auth.svg";
import yandexAuthIcon from "../../assets/yandex-auth.svg";
import type { VivaOAuthProvider } from "../../context/authShared";
import { useAuth } from "../../context/authShared";
import { useCountdown } from "../../hooks/useCountdown";
import { AUTH_CONSENT_DOCUMENTS, stageAuthConsents } from "../../utils/authConsents";
import { PhoneInput } from "./PhoneInput";

type VivaAuthStep = "chooser" | "phone" | "code" | "verify-phone" | "verify-code";

function OAuthButton({
  provider,
  label,
  icon,
  disabled,
  onClick,
}: {
  provider: VivaOAuthProvider;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: (provider: VivaOAuthProvider) => void;
}) {
  return (
    <button
      type="button"
      className="auth-oauth-btn"
      onClick={() => onClick(provider)}
      disabled={disabled}
    >
      <span className="auth-oauth-btn__content">
        <span className="auth-oauth-btn__icon" aria-hidden="true">
          {icon}
        </span>
        <span>{label}</span>
      </span>
    </button>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 7.5L10 12.5L15 7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CodeInputStep({
  title,
  subtitle,
  error,
  isBusy,
  onVerify,
  onResend,
  onBack,
}: {
  title: string;
  subtitle: ReactNode;
  error: string | null;
  isBusy: boolean;
  onVerify: (code: string) => Promise<unknown> | unknown;
  onResend: () => Promise<unknown> | unknown;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [isResending, setIsResending] = useState(false);
  const { timeLeft, reset } = useCountdown(90);

  const handleCodeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value.replace(/\D/g, "").slice(0, 4);
    setCode(nextValue);
    if (nextValue.length === 4) {
      void onVerify(nextValue);
      setCode("");
    }
  };

  const handleResend = async () => {
    setIsResending(true);
    await onResend();
    reset();
    setIsResending(false);
  };

  const timeString = `${Math.floor(timeLeft / 60)}:${(timeLeft % 60).toString().padStart(2, "0")}`;

  return (
    <div className="auth-card">
      <p className="auth-title">{title}</p>
      <div className="resend-row">
        <input
          type="tel"
          inputMode="numeric"
          maxLength={4}
          value={code}
          onChange={handleCodeChange}
          placeholder="Код из 4 цифр"
          className="auth-input"
          disabled={isBusy}
        />
        {timeLeft <= 0 && (
          <button
            type="button"
            onClick={handleResend}
            disabled={isResending || isBusy}
            className="auth-icon-btn"
          >
            <img src={resendImg} className="resend-img" alt="Отправить снова" />
          </button>
        )}
      </div>
      <p className="auth-subtitle">
        {subtitle}
        <br />
        <br />
        Код действует {timeString}
      </p>
      {error && <p className="auth-error">{error}</p>}
      <button type="button" className="auth-link auth-link-btn" onClick={onBack}>
        ← Назад
      </button>
    </div>
  );
}

export function VivaAuthForm({
  onLogin,
  allowPhoneLogin = true,
}: {
  onLogin: () => void;
  allowPhoneLogin?: boolean;
}) {
  const {
    phone,
    error,
    clearError,
    sendCode,
    login,
    startOAuth,
    isLoading,
    needsPhoneVerification,
    sendPhoneVerificationCode,
    verifyPhone,
    isAuthenticated,
  } = useAuth();
  const [step, setStep] = useState<VivaAuthStep>("chooser");
  const [draftPhone, setDraftPhone] = useState(phone || "");
  const [isMoreOptionsOpen, setIsMoreOptionsOpen] = useState(false);
  const [hasAcceptedOffer, setHasAcceptedOffer] = useState(false);
  const [hasAcceptedPersonalData, setHasAcceptedPersonalData] = useState(false);
  const [consentAuditError, setConsentAuditError] = useState<string | null>(null);
  const offerConsentId = useId();
  const personalDataConsentId = useId();
  const hasRequiredConsents = hasAcceptedOffer && hasAcceptedPersonalData;

  useEffect(() => {
    setDraftPhone(phone || "");
  }, [phone]);

  useEffect(() => {
    if (isAuthenticated && !needsPhoneVerification) {
      onLogin();
    }
  }, [isAuthenticated, needsPhoneVerification, onLogin]);

  useEffect(() => {
    if (needsPhoneVerification) {
      setStep(draftPhone.length === 11 ? "verify-code" : "verify-phone");
    }
  }, [draftPhone.length, needsPhoneVerification]);

  useEffect(() => {
    if (allowPhoneLogin) return;
    setIsMoreOptionsOpen(false);
    setStep((current) => (current === "phone" || current === "code" ? "chooser" : current));
  }, [allowPhoneLogin]);

  const handleSmsSend = async () => {
    setConsentAuditError(null);
    const staged = await stageAuthConsents({
      authMethod: "sms",
      bindingType: "sms-phone",
      bindingValue: draftPhone,
    });
    if (!staged) {
      setConsentAuditError("Не удалось сохранить согласия. Проверьте настройки браузера и попробуйте снова.");
      return;
    }
    const ok = await sendCode(draftPhone, "cascade");
    if (ok) {
      setStep("code");
    }
  };

  const handleSmsVerify = async (code: string) => {
    const ok = await login(draftPhone, code);
    if (ok) {
      onLogin();
    }
  };

  const handleVerificationSend = async () => {
    const ok = await sendPhoneVerificationCode(draftPhone, "cascade");
    if (ok) {
      setStep("verify-code");
    }
  };

  const handleVerificationCode = async (code: string) => {
    const ok = await verifyPhone(draftPhone, code);
    if (ok) {
      onLogin();
    }
  };

  const handleStartOAuth = (provider: VivaOAuthProvider) => {
    if (!hasRequiredConsents) return;
    setConsentAuditError(null);
    clearError();
    setIsMoreOptionsOpen(false);
    startOAuth(provider);
  };

  const openPhoneLogin = () => {
    if (!allowPhoneLogin || !hasRequiredConsents) return;
    clearError();
    setIsMoreOptionsOpen(false);
    setStep("phone");
  };

  if (step === "phone") {
    return (
      <div className="auth-wrapper">
        <div className="auth-card">
          <p className="auth-title">Вход по SMS</p>
          <p className="auth-subtitle">Введите номер телефона, чтобы получить код подтверждения.</p>
          <PhoneInput value={draftPhone} onChange={setDraftPhone} />
          <button
            type="button"
            className="auth-btn"
            onClick={handleSmsSend}
            disabled={draftPhone.length !== 11 || isLoading}
          >
            Получить код
          </button>
          {(consentAuditError || error) && <p className="auth-error">{consentAuditError || error}</p>}
          <button type="button" className="auth-link auth-link-btn" onClick={() => { clearError(); setStep("chooser"); }}>
            ← Выбрать другой способ
          </button>
        </div>
      </div>
    );
  }

  if (step === "code") {
    return (
      <div className="auth-wrapper">
        <CodeInputStep
          title="Подтвердите вход"
          subtitle={<>Код отправлен на номер +{draftPhone}</>}
          error={error}
          isBusy={isLoading}
          onVerify={handleSmsVerify}
          onResend={() => sendCode(draftPhone, "cascade")}
          onBack={() => { clearError(); setStep("phone"); }}
        />
      </div>
    );
  }

  if (step === "verify-phone") {
    return (
      <div className="auth-wrapper">
        <div className="auth-card">
          <p className="auth-title">Подтвердите номер</p>
          <p className="auth-subtitle">После входа через VK или Яндекс нужно привязать телефон к профилю Viva.</p>
          <PhoneInput value={draftPhone} onChange={setDraftPhone} />
          <button
            type="button"
            className="auth-btn"
            onClick={handleVerificationSend}
            disabled={draftPhone.length !== 11 || isLoading}
          >
            Отправить код
          </button>
          {error && <p className="auth-error">{error}</p>}
          <button type="button" className="auth-link auth-link-btn" onClick={() => { clearError(); setStep("chooser"); }}>
            ← Назад
          </button>
        </div>
      </div>
    );
  }

  if (step === "verify-code") {
    return (
      <div className="auth-wrapper">
        <CodeInputStep
          title="Подтвердите номер"
          subtitle={<>Код отправлен на номер +{draftPhone}</>}
          error={error}
          isBusy={isLoading}
          onVerify={handleVerificationCode}
          onResend={handleVerificationSend}
          onBack={() => { clearError(); setStep("verify-phone"); }}
        />
      </div>
    );
  }

  return (
    <div className="auth-wrapper">
      <div className="auth-card auth-card-chooser">
        <div className="auth-brand-lockup">
          <img src={logoHabBlack} alt="ПадлхАБ" className="auth-brand-logo" />
          <p className="auth-title auth-title--brand">войти в личный кабинет</p>
        </div>
        <OAuthButton
          provider="vkid"
          label="VK ID или Mail.ru"
          icon={<img src={vkAuthIcon} alt="" className="auth-provider-icon-image" />}
          disabled={isLoading || !hasRequiredConsents}
          onClick={handleStartOAuth}
        />
        <OAuthButton
          provider="yandex"
          label="Yandex"
          icon={<img src={yandexAuthIcon} alt="" className="auth-provider-icon-image" />}
          disabled={isLoading || !hasRequiredConsents}
          onClick={handleStartOAuth}
        />
        <fieldset className="auth-consents">
          <legend className="auth-consents__legend">Обязательные согласия</legend>
          <div className="auth-consent">
            <input
              id={offerConsentId}
              type="checkbox"
              className="auth-consent__checkbox"
              checked={hasAcceptedOffer}
              onChange={(event) => setHasAcceptedOffer(event.target.checked)}
            />
            <label htmlFor={offerConsentId} className="auth-consent__label">
              Принимаю условия{" "}
              <a
                href={AUTH_CONSENT_DOCUMENTS[0].url}
                target="_blank"
                rel="noopener noreferrer"
                className="auth-consent__link"
              >
                публичной оферты
              </a>
            </label>
          </div>
          <div className="auth-consent">
            <input
              id={personalDataConsentId}
              type="checkbox"
              className="auth-consent__checkbox"
              checked={hasAcceptedPersonalData}
              onChange={(event) => setHasAcceptedPersonalData(event.target.checked)}
            />
            <label htmlFor={personalDataConsentId} className="auth-consent__label">
              Даю согласие на{" "}
              <a
                href={AUTH_CONSENT_DOCUMENTS[1].url}
                target="_blank"
                rel="noopener noreferrer"
                className="auth-consent__link"
              >
                обработку персональных данных
              </a>
            </label>
          </div>
        </fieldset>
        {allowPhoneLogin && (
          <div className="auth-more-options">
            <button
              type="button"
              className="auth-btn auth-btn-secondary auth-more-options-btn"
              onClick={() => {
                clearError();
                setIsMoreOptionsOpen((current) => !current);
              }}
              disabled={isLoading || !hasRequiredConsents}
              aria-expanded={isMoreOptionsOpen}
              aria-controls="auth-more-options-popover"
            >
              <span>Еще варианты</span>
              <ChevronDownIcon />
            </button>
            {isMoreOptionsOpen && (
              <div id="auth-more-options-popover" className="auth-more-options-popover">
                <button type="button" className="auth-more-options-item" onClick={openPhoneLogin}>
                  Войти по номеру
                </button>
              </div>
            )}
          </div>
        )}
        {(consentAuditError || error) && <p className="auth-error">{consentAuditError || error}</p>}
      </div>
    </div>
  );
}
