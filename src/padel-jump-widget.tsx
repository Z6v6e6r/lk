import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RaceEntry from './components/padel-jump/RaceEntry';
import PadelJump from './components/padel-jump/PadelJump';
import liveStyles from './components/padel-jump/live.css?inline';
import practiceStyles from './components/padel-jump/padel-jump.css?inline';
import startStyles from './components/padel-jump/jump-start.css?inline';

const mounts = new WeakMap<HTMLElement, () => void>();

/** No tokens or profile data cross this boundary; the module runs in the cabinet document. */
export function mount(target: HTMLElement, mode: 'race' | 'practice') {
  unmount(target);
  const owner = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = `${liveStyles}\n${practiceStyles}\n${startStyles}`;
  const content = document.createElement('div');
  owner.append(style, content);
  target.append(owner);
  const root = createRoot(content);
  mounts.set(target, () => {
    // A host StrictMode cleanup can run during another root's commit. Keep
    // disposal asynchronous and confined to this generation's owned element.
    queueMicrotask(() => { root.unmount(); owner.remove(); });
  });
  root.render(<StrictMode>{mode === 'race' ? <RaceEntry /> : <PadelJump onBack={() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('padelJump');
    window.location.assign(url.toString());
  }} />}</StrictMode>);
}

export function unmount(target: HTMLElement) {
  const dispose = mounts.get(target);
  mounts.delete(target);
  dispose?.();
}
