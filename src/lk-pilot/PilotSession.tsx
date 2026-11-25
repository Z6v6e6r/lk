import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AuthContext, type AuthContextType } from "../context/authShared";
import { readAuthToken } from "../utils/authTokenStorage";
import { extractJwtStringClaim, getJwtExpiryTimestamp } from "../utils/vivaAuthJwt";

type Session = { phone: string; identity: string };

function readSession(): Session | null {
  const token = readAuthToken();
  const expiresAt = getJwtExpiryTimestamp(token);
  const phone = extractJwtStringClaim(token, ["phone_number", "phoneNumber", "phone"]);
  const issuer = extractJwtStringClaim(token, ["iss"]);
  const subject = extractJwtStringClaim(token, ["sub"]);
  if (!expiresAt || expiresAt <= Date.now() || !phone || !issuer || !subject) return null;
  return { phone, identity: JSON.stringify([issuer, subject]) };
}

const ComparisonScope = createContext<string | null>(null);
const saltKey = "lk1-pilot-comparison-salt";

async function makeComparisonScope(identity: string) {
  let salt = sessionStorage.getItem(saltKey);
  if (!salt) {
    salt = crypto.randomUUID();
    sessionStorage.setItem(saltKey, salt);
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + identity));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function usePilotComparisonScope() {
  return useContext(ComparisonScope);
}

const unavailable = async () => false;
const stayInPilot = () => undefined;

export function PilotSession({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(readSession);
  const [comparison, setComparison] = useState<{ identity: string; digest: string } | null>(null);
  const identity = active?.identity ?? null;
  const phone = active?.phone ?? "";

  useEffect(() => {
    const read = () => {
      const next = readSession();
      setActive((previous) => previous?.identity === next?.identity && previous?.phone === next?.phone
        ? previous : next);
    };
    window.addEventListener("focus", read);
    window.addEventListener("storage", read);
    const interval = window.setInterval(read, 5000);
    return () => {
      window.removeEventListener("focus", read);
      window.removeEventListener("storage", read);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!identity) return;
    let relevant = true;
    void makeComparisonScope(identity).then((digest) => {
      if (relevant) setComparison({ identity, digest });
    }).catch(() => {});
    return () => { relevant = false; };
  }, [identity]);

  const scope = identity && comparison?.identity === identity ? comparison.digest : null;
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

  return <AuthContext.Provider key={identity ?? "guest"} value={session}>
    {!phone && <p className="lk-pilot-session">Персональные цены доступны после входа в обычном ЛК.</p>}
    <ComparisonScope.Provider value={scope}>{children}</ComparisonScope.Provider>
  </AuthContext.Provider>;
}
