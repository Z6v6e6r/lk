import type { createReadonlyRenderer } from './renderer';
export function mountLiveSpectator(root: HTMLElement, options: {
  logoUrl: string;
  createRenderer: typeof createReadonlyRenderer;
  onJoin: () => void;
  profile?: 'normal' | 'constrained' | 'fallback';
  api?: string;
  onError?: (error: unknown) => void;
}): () => void;
