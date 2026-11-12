type BackgroundKind = 'roster_sync' | 'related_phones';
type Job = { scope: string; signature: string; promise: Promise<unknown> };
type Resource = { writes: number; holds: number; job?: Job; completed: Set<string> };
type Registry = { version: 1; resources: Map<string, Resource> };
type Host = typeof globalThis;
const key = Symbol.for('padlhub.gamePatchCoordinator.v1');
type Admission<T> = { kind: 'done'; value: T } | { kind: 'skipped'; reason: 'busy' | 'completed' | 'unavailable' | 'session_changed' };

function registry(host: Host): Registry | null {
  try {
    const existing = Reflect.get(host, key) as Registry | undefined;
    if (existing !== undefined) return existing?.version === 1 && existing.resources instanceof Map ? existing : null;
    const value: Registry = { version: 1, resources: new Map() };
    Object.defineProperty(host, key, { value });
    return value;
  } catch { return null; }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}

async function digest(host: Host, value: unknown): Promise<string | null> {
  try {
    const bytes = await host.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(value))));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

// One registry per document, including separately evaluated cabinet/games IIFEs.
// No storage, queue, payload cache, token keys, diagnostic output or business retry.
export async function coordinateGamePatch<T>(options: {
  backend: string; tenant: string; gameId: string; token: string | null;
  payload: unknown; background?: { kind: BackgroundKind; intent: unknown };
  current: () => boolean; run: () => Promise<T>; host?: Host;
}): Promise<Admission<T>> {
  const host = options.host ?? globalThis;
  const state = registry(host);
  const name = JSON.stringify([options.backend, options.tenant, options.gameId]);
  let resource = state?.resources.get(name);
  if (state && !resource) {
    if (state.resources.size >= 128) {
      for (const [id, entry] of state.resources) if (!entry.job && entry.writes === 0 && entry.holds === 0) { state.resources.delete(id); break; }
    }
    resource = { writes: 0, holds: 0, completed: new Set() }; state.resources.set(name, resource);
  }
  if (!options.background) {
    // Mandatory finalizers/manual intents retain their original admission. They
    // are observed so a later background repair cannot compete with them.
    if (resource) resource.writes++;
    try { return { kind: 'done', value: await options.run() }; }
    finally { if (resource) resource.writes--; }
  }
  if (!resource || !options.token || !['roster_sync', 'related_phones'].includes(options.background.kind) || options.background.intent === undefined) return { kind: 'skipped', reason: 'unavailable' };
  resource.holds++;
  try {
    const [scope, payload, intent] = await Promise.all([
      digest(host, options.token), digest(host, options.payload), digest(host, [options.background.kind, options.background.intent]),
    ]);
    if (!options.current()) return { kind: 'skipped', reason: 'session_changed' };
    if (!scope || !payload || !intent) return { kind: 'skipped', reason: 'unavailable' };
    const signature = `${scope}:${options.background.kind}:${payload}`;
    const cycle = `${scope}:${intent}`;
    if (resource.writes) return { kind: 'skipped', reason: 'busy' };
    if (resource.job) return resource.job.scope === scope && resource.job.signature === signature
      ? { kind: 'done', value: await resource.job.promise as T }
      : { kind: 'skipped', reason: 'busy' };
    if (resource.completed.has(cycle)) return { kind: 'skipped', reason: 'completed' };
    const shared = resource;
    // Retain a bounded digest tombstone through rerenders and canonical replacement.
    // A version change alone never retries the same repair intent after a 409.
    shared.completed.add(cycle);
    if (shared.completed.size > 16) shared.completed.delete(shared.completed.values().next().value!);
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { scope, signature, promise };
    shared.job = job;
    try {
      try { options.run().then(resolve, reject); } catch (error) { reject(error); }
      return { kind: 'done', value: await promise };
    }
    finally { if (shared.job === job) delete shared.job; }
  } finally { resource.holds--; }
}
