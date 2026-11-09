import { useEffect, useRef, useState } from 'react';
import { isExhibitionRoute } from './exhibition';

declare const __PADLHUB_JUMP_WIDGET_URL__: string;
declare const __PADLHUB_EXHIBITION_WIDGET_URL__: string;
type GameModule = {
  mount: (target: HTMLElement, mode: 'race' | 'practice' | 'live') => void;
  unmount: (target: HTMLElement) => void;
};
const readyModules = new Map<string, GameModule>();

/** Only the explicit game route loads code; identity stays in this document's origin. */
export default function PadelJumpHost({ mode }: { mode: 'race' | 'practice' | 'live' }) {
  const target = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const container = target.current;
    if (!container) return;
    let cancelled = false;
    let mounted: GameModule | undefined;
    setStatus('loading');
    const src = isExhibitionRoute() ? __PADLHUB_EXHIBITION_WIDGET_URL__ : __PADLHUB_JUMP_WIDGET_URL__;
    if (!src) { setStatus('error'); return; }
    const url = attempt ? `${src}?retry=${attempt}` : src;
    const readyModule = readyModules.get(src);
    const load = readyModule ? Promise.resolve(readyModule) : import(/* @vite-ignore */ url);
    void load.then((module: GameModule) => {
      if (typeof module.mount !== 'function' || typeof module.unmount !== 'function') throw new Error('Invalid game module');
      readyModules.set(src, module);
      if (cancelled) return;
      mounted = module;
      module.mount(container, mode);
      setStatus('ready');
    }).catch(() => {
      if (!cancelled) setStatus('error');
    });
    return () => {
      cancelled = true;
      mounted?.unmount(container);
    };
  }, [attempt, mode]);
  return <div className="padel-jump-host">
    {status === 'loading' && <div role="status">Загружаем ПадлхАБ Jump…</div>}
    {status === 'error' && <div role="alert">Не удалось загрузить игру. <button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></div>}
    <div ref={target} />
  </div>;
}
