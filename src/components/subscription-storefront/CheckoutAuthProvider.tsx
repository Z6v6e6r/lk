import type { ReactNode } from 'react';
import { LegacyAuthProvider } from '../../context/LegacyAuthProvider';
import { VivaAuthProvider } from '../../context/VivaAuthProvider';
import { resolveConfiguredAuthMode } from '../../utils/authMode';

/** Reuse the normal auth protocol without installing page-wide LK tracking/idle guards. */
export function CheckoutAuthProvider({ children }: { children: ReactNode }) {
  return resolveConfiguredAuthMode() === 'viva'
    ? <VivaAuthProvider>{children}</VivaAuthProvider>
    : <LegacyAuthProvider>{children}</LegacyAuthProvider>;
}
