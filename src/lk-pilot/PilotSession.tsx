import { useEffect, useState, type ReactNode } from "react";
import { AuthContext, type AuthContextType } from "../context/authShared";
import { readAuthToken } from "../utils/authTokenStorage";
import { extractJwtStringClaim, getJwtExpiryTimestamp } from "../utils/vivaAuthJwt";

function readSessionPhone(): string {
  const token = readAuthToken();
  const expiresAt = getJwtExpiryTimestamp(token);
  if (!expiresAt || expiresAt <= Date.now()) return "";
  return extractJwtStringClaim(token, ["phone_number", "phoneNumber", "phone"]) ?? "";
}

const unavailable = async () => false;
const stayInPilot = () => undefined;

export function PilotSession({ children }: { children: ReactNode }) {
  const [phone, setPhone] = useState(readSessionPhone);

  useEffect(() => {
    const read = () => setPhone(readSessionPhone());
    window.addEventListener("focus", read);
    window.addEventListener("storage", read);
    const interval = window.setInterval(read, 5000);
    return () => {
      window.removeEventListener("focus", read);
      window.removeEventListener("storage", read);
      window.clearInterval(interval);
    };
  }, []);

  const session: AuthContextType = {
    isAuthenticated: Boolean(phone),
    phone,
    sendCode: unavailable,
    login: unavailable,
    logout: stayInPilot,
    error: null,
    clearError: stayInPilot,
    authMode: "viva",
    supportsOAuth: false,
    isLoading: false,
    isRestoringSession: false,
    needsPhoneVerification: false,
    startOAuth: stayInPilot,
    sendPhoneVerificationCode: unavailable,
    verifyPhone: unavailable,
  };

  return <AuthContext.Provider value={session}>
    {!phone && <p className="lk-pilot-session">Персональные цены доступны после входа в обычном ЛК.</p>}
    {children}
  </AuthContext.Provider>;
}
