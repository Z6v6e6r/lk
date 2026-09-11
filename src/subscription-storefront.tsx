import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { SubscriptionPage } from './components/subscription-storefront/SubscriptionPage';
import type { SubscriptionStorefrontView } from './components/subscription-storefront/model';
import { AuthProvider } from './context/AuthContext';
import { CABINET_URL } from './consts/api_config';
import { installGlobalErrorTracking, trackAnalyticsEvent } from './utils/analytics';

type MountData = { previewView?: SubscriptionStorefrontView; cabinetUrl?: string | null };
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
  installGlobalErrorTracking();
  trackAnalyticsEvent('widget_bundle_loaded', { entry: 'subscription-storefront' });
  unmount();
  root = createRoot(container);
  root.render(
    <StrictMode>
      <Boundary>
        <AuthProvider>
          <SubscriptionPage
            cabinetUrl={cabinetUrl}
            onBack={options.onClose}
            previewView={localPreview ? options.data?.previewView : undefined}
          />
        </AuthProvider>
      </Boundary>
    </StrictMode>,
  );
}

declare global { interface Window { LKWidgetSubscriptionStorefront?: { mount: typeof mount; unmount: typeof unmount } } }
window.LKWidgetSubscriptionStorefront = { mount, unmount };
export { mount, unmount };
