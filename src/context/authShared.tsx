import { createContext, useContext } from "react";

export type AuthMode = "legacy" | "viva";
export type VivaOAuthProvider = "vkid" | "yandex";

export type AuthContextType = {
  isAuthenticated: boolean;
  phone: string;
  sendCode: (phone: string, channel?: string) => Promise<boolean>;
  login: (phone: string, code: string) => Promise<boolean>;
  logout: () => void;
  error: string | null;
  clearError: () => void;
  authMode: AuthMode;
  supportsOAuth: boolean;
  isLoading: boolean;
  isRestoringSession: boolean;
  needsPhoneVerification: boolean;
  startOAuth: (provider: VivaOAuthProvider) => void;
  sendPhoneVerificationCode: (phone: string, channel?: string) => Promise<boolean>;
  verifyPhone: (phone: string, code: string) => Promise<boolean>;
};

const defaultAuthContext: AuthContextType = {
  isAuthenticated: false,
  phone: "",
  sendCode: async () => false,
  login: async () => false,
  logout: () => {},
  error: null,
  clearError: () => {},
  authMode: "legacy",
  supportsOAuth: false,
  isLoading: false,
  isRestoringSession: false,
  needsPhoneVerification: false,
  startOAuth: () => {},
  sendPhoneVerificationCode: async () => false,
  verifyPhone: async () => false,
};

export const AuthContext = createContext<AuthContextType>(defaultAuthContext);

export function useAuth() {
  return useContext(AuthContext);
}
