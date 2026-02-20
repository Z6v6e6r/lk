import { createContext, useContext, useState, useEffect } from "react";
import { getCookie, setCookie, deleteCookie } from "../utils/cookies";
import { TENANT_KEY, KEYCLOAK_BASE } from "../consts/api_config";

type AuthContextType = {
  isAuthenticated: boolean;
  phone: string;
  sendCode: (phone: string, channel?: string) => Promise<boolean>;
  login: (phone: string, code: string) => Promise<boolean>;
  logout: () => void;
  error: string | null;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  phone: "",
  sendCode: async () => false,
  login: async () => false,
  logout: () => {},
  error: null,
  clearError: () => {},
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getCookie(`${TENANT_KEY}AuthToken`);
    if (token) setIsAuthenticated(true);
  }, []);

  const clearError = () => setError(null);

  const sendCode = async (
    phoneNumber: string,
    channel = "cascade",
  ): Promise<boolean> => {
    clearError();
    setPhone(phoneNumber);
    try {
      const res = await fetch(
        `${KEYCLOAK_BASE}/realms/prod/sms/authentication-code?phoneNumber=${phoneNumber}&channel=${channel}&tenantKey=${TENANT_KEY}`,
        { method: "GET" },
      );
      if (res.ok) {
        return true;
      } else {
        setError("Не удалось отправить код");
        return false;
      }
    } catch (err) {
      setError(`Ошибка сети ${err}`);
      return false;
    }
  };

  const login = async (phoneNumber: string, code: string): Promise<boolean> => {
    clearError();
    const formData = new URLSearchParams();
    formData.append("grant_type", "password");
    formData.append("phone_number", phoneNumber);
    formData.append("code", code);
    formData.append("client_id", "widget");
    formData.append("tenant_key", TENANT_KEY);

    try {
      const res = await fetch(
        `${KEYCLOAK_BASE}/realms/prod/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formData.toString(),
        },
      );

      const data = await res.json();
      if (res.ok && data.access_token) {
        setCookie(`${TENANT_KEY}AuthToken`, data.access_token, data.expires_in);
        setCookie(
          `${TENANT_KEY}RefreshToken`,
          data.refresh_token,
          data.refresh_expires_in,
        );
        setIsAuthenticated(true);
        return true;
      } else {
        setError(data.error_description || "Неверный код");
        return false;
      }
    } catch (err) {
      setError(`Ошибка при входе ${err}`);
      return false;
    }
  };

  const logout = () => {
    deleteCookie(`${TENANT_KEY}AuthToken`);
    deleteCookie(`${TENANT_KEY}RefreshToken`);
    setIsAuthenticated(false);
    setPhone("");
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        phone,
        sendCode,
        login,
        logout,
        error,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
