import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { SubscriptionPage } from './components/subscription-storefront/SubscriptionPage';
import { PromoSubscriptionPage } from './components/subscription-storefront/PromoSubscriptionPage';
import { readStorefrontPromoKey } from './components/subscription-storefront/promo';
import type { SubscriptionStorefrontView } from './components/subscription-storefront/model';
import { AuthProvider } from './context/AuthContext';
import { CABINET_URL, IS_DEV_RELEASE_CHANNEL } from './consts/api_config';
import { installGlobalErrorTracking, trackAnalyticsEvent } from './utils/analytics';
import './components/subscription-storefront/storefront-idle-guard.css';
import { openCheckout, closeCheckout, resumeCheckout } from './components/subscription-storefront/zeroCheckoutMount';

type MountData = { previewView?: SubscriptionStorefrontView; cabinetUrl?: string | null; variant?: string | null };
type MountOptions = { targetId?: string; onClose?: () => void; data?: MountData };

let root: Root | null = null;

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">Не удалось показать подписки. Обновите страницу.</p> : this.props.children; }
}

/** Cabinet target used after a confirmed payment or when the widget is closed. */
function resolveCabinetUrl(data?: MountData): string {
  const explicit = String(data?.cabinetUrl || '').trim();
  if (explicit) return explicit;
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const fromQuery = String(new URLSearchParams(search).get('cabinetUrl') || '').trim();
  return fromQuery || CABINET_URL || '';
}

function unmount() { root?.unmount(); root = null; }

function mount(options: MountOptions = {}) {
  const container = document.getElementById(options.targetId ?? 'padlhub-subscriptions');
  if (!container) throw new Error('Subscription storefront mount target not found');
  const localPreview = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const cabinetUrl = resolveCabinetUrl(options.data);
  const offerKey = readStorefrontPromoKey(window.location.search);
  installGlobalErrorTracking();
  trackAnalyticsEvent('widget_bundle_loaded', { entry: 'subscription-storefront' });
  unmount();
  root = createRoot(container);
  root.render(
    <StrictMode>
      <Boundary>
        <AuthProvider>
          {offerKey !== null ? <PromoSubscriptionPage offerKey={offerKey} cabinetUrl={cabinetUrl} onBack={options.onClose} /> : <SubscriptionPage
            cabinetUrl={cabinetUrl}
            onBack={options.onClose}
            variant={options.data?.variant}
            previewView={localPreview ? options.data?.previewView : undefined}
          />}
        </AuthProvider>
      </Boundary>
    </StrictMode>,
  );
}

declare global { interface Window { LKWidgetSubscriptionStorefront?: {
  mount: typeof mount; unmount: typeof unmount;
  checkoutVersion: 1; checkoutChannel: 'prod' | 'dev'; openCheckout: typeof openCheckout; closeCheckout: typeof closeCheckout; resumeCheckout: typeof resumeCheckout;
} } }
window.LKWidgetSubscriptionStorefront = { mount, unmount, checkoutVersion: 1, checkoutChannel: IS_DEV_RELEASE_CHANNEL ? 'dev' : 'prod', openCheckout, closeCheckout, resumeCheckout };
export { mount, unmount };
