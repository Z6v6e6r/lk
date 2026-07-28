import { useAuth } from "../../context/AuthContext";
import { LegacyAuthForm } from "./LegacyAuthForm";
import { VivaAuthForm } from "./VivaAuthForm";

export function AuthForm({
  onLogin,
  allowPhoneLogin = true,
}: {
  onLogin: () => void;
  allowPhoneLogin?: boolean;
}) {
  const { authMode, supportsOAuth } = useAuth();

  if (authMode === "viva" || supportsOAuth) {
    return <VivaAuthForm onLogin={onLogin} allowPhoneLogin={allowPhoneLogin} />;
  }

  return <LegacyAuthForm onLogin={onLogin} />;
}
