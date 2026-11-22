// Each iframe has its own JS realm. These wrappers are installed BEFORE any
// production component is imported, so preview caches cannot touch LK caches.
export function isolatedStorage(storage: Storage, prefix = 'padlhub-booking-preview:') {
  const keys = () => Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null && key.startsWith(prefix));
  return new Proxy({} as Storage, {
    get(_target, property) {
      if (property === 'getItem') return (key: string) => storage.getItem(prefix + key);
      if (property === 'setItem') return (key: string, value: string) => storage.setItem(prefix + key, String(value));
      if (property === 'removeItem') return (key: string) => storage.removeItem(prefix + key);
      if (property === 'clear') return () => keys().forEach(key => storage.removeItem(key));
      if (property === 'key') return (index: number) => keys()[index]?.slice(prefix.length) ?? null;
      if (property === 'length') return keys().length;
      return typeof property === 'string' ? storage.getItem(prefix + property) ?? undefined : undefined;
    },
    set(_target, property, value) {
      if (typeof property === 'string') storage.setItem(prefix + property, String(value));
      return true;
    },
    deleteProperty(_target, property) {
      if (typeof property === 'string') storage.removeItem(prefix + property);
      return true;
    },
    ownKeys: () => keys().map(key => key.slice(prefix.length)),
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
  });
}

export function installPreviewIsolation() {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(window, name, { value: isolatedStorage(window[name]) });
  }
  Object.defineProperty(document, 'cookie', { get: () => '', set: () => {} });
  const OriginalChannel = window.BroadcastChannel;
  if (OriginalChannel) window.BroadcastChannel = class extends OriginalChannel {
    constructor(name: string) { super('padlhub-booking-preview:' + name); }
  };
}
