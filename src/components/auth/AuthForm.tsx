import { useAuth } from "../../context/AuthContext";
import { LegacyAuthForm } from "./LegacyAuthForm";
import { VivaAuthForm } from "./VivaAuthForm";

export function AuthForm({
  onLogin,
  allowPhoneLogin = true,
  brandLogo,
}: {
  onLogin: () => void;
  allowPhoneLogin?: boolean;
  brandLogo?: { src: string; alt: string };
}) {
  const { authMode, supportsOAuth } = useAuth();

  if (authMode === "viva" || supportsOAuth) {
    return <VivaAuthForm onLogin={onLogin} allowPhoneLogin={allowPhoneLogin} brandLogo={brandLogo} />;
  }

  return <LegacyAuthForm onLogin={onLogin} />;
}
