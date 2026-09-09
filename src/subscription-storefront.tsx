import { createRoot, type Root } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { SubscriptionPage } from './components/subscription-storefront/SubscriptionPage';
import type { SubscriptionStorefrontView } from './components/subscription-storefront/model';

type MountOptions = { targetId?: string; onClose?: () => void; data?: { previewView?: SubscriptionStorefrontView } };
let root: Root | null = null;
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">Не удалось показать подписки. Обновите страницу.</p> : this.props.children; }
}
function unmount() { root?.unmount(); root = null; }
function mount(options: MountOptions = {}) {
  const container = document.getElementById(options.targetId ?? 'padlhub-subscriptions');
  if (!container) throw new Error('Subscription storefront mount target not found');
  unmount();
  root = createRoot(container);
  const localPreview = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  root.render(<Boundary><SubscriptionPage onBack={options.onClose}
    previewView={localPreview ? options.data?.previewView : undefined} /></Boundary>);
}
declare global { interface Window { LKWidgetSubscriptionStorefront?: { mount: typeof mount; unmount: typeof unmount } } }
window.LKWidgetSubscriptionStorefront = { mount, unmount };
export { mount, unmount };
