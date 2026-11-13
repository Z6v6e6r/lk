import type { ReactNode } from 'react';
import { useState } from 'react';
import { AuthContext, useAuth, type AuthContextType } from '../../src/context/authShared';
import { profile, setDemoAuthenticated } from './fixtures';

export { useAuth };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setAuthenticated] = useState(new URLSearchParams(location.search).get('state') !== 'guest');
  const value: AuthContextType = {
    isAuthenticated,
    phone: isAuthenticated ? profile.phone : '',
    authMode: 'legacy', supportsOAuth: false, isLoading: false,
    isRestoringSession: false, needsPhoneVerification: false, error: null,
    sendCode: async () => true,
    login: async () => { setDemoAuthenticated(true); setAuthenticated(true); return true; },
    logout: () => { setDemoAuthenticated(false); setAuthenticated(false); }, clearError: () => {}, startOAuth: () => {},
    sendPhoneVerificationCode: async () => true, verifyPhone: async () => true,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
