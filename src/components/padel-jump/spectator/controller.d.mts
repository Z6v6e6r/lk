import type { createReadonlyRenderer } from './renderer';
export function mountLiveSpectator(root: HTMLElement, options: {
  logoUrl: string;
  createRenderer: typeof createReadonlyRenderer;
  onJoin: () => void;
  profile?: 'normal' | 'constrained' | 'fallback';
  api?: string;
  onError?: (error: unknown) => void;
  /** 16:9 TV stage: large type, idle podium rating, automatic rotation. */
  tv?: boolean;
  /** Offline demo scenario ('1'..'7' or 'loop'); disables all network reads. */
  demo?: string | null;
  /** Show labelled demo games after a long outage (defaults to `tv`). */
  offlineDemo?: boolean;
}): () => void;
