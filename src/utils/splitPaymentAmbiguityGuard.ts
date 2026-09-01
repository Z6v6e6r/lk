interface AmbiguityGuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class SplitPaymentAmbiguityGuard {
  private readonly ambiguousIntentByScope = new Map<string, string>();
  private readonly storage: AmbiguityGuardStorage | null;
  private readonly storageKey: string;

  constructor(storage: AmbiguityGuardStorage | null = null, storageKey = "lk_split_ambiguous_intents_v1") {
    this.storage = storage;
    this.storageKey = storageKey;
  }

  private syncFromStorage(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      this.ambiguousIntentByScope.clear();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [scope, intent] of Object.entries(parsed)) {
        if (scope && typeof intent === "string" && intent) {
          this.ambiguousIntentByScope.set(scope, intent);
        }
      }
    } catch {
      // Storage is an optional cross-reload UX guard; the in-memory guard remains active.
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.ambiguousIntentByScope)));
    } catch {
      // Keep the in-memory guard fail-closed for this tab when storage is unavailable.
    }
  }

  canStart(scopeKey: string, intentKey: string): boolean {
    this.syncFromStorage();
    const ambiguousIntent = this.ambiguousIntentByScope.get(scopeKey);
    return !ambiguousIntent || ambiguousIntent === intentKey;
  }

  markAmbiguous(scopeKey: string, intentKey: string): void {
    this.syncFromStorage();
    this.ambiguousIntentByScope.set(scopeKey, intentKey);
    this.persist();
  }

  markSettled(scopeKey: string, intentKey: string): void {
    this.syncFromStorage();
    if (this.ambiguousIntentByScope.get(scopeKey) === intentKey) {
      this.ambiguousIntentByScope.delete(scopeKey);
      this.persist();
    }
  }
}
