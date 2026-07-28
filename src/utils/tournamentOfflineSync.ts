import { apiUpdateAmericanoResults, type AmericanoResultsPayload, type AmericanoResultsResponse, type Exercise, type TournamentHistoryRecord, type UserProfileType, type ApiResult } from "./apiClient";
import {
  computeTournamentOfflineRetryDelayMs,
  getTournamentOfflineResultQueueScope,
  mergeTournamentOfflineResultPayloads,
  shouldQueueTournamentResultError,
} from "./tournamentOfflineSyncPolicy";

export {
  computeTournamentOfflineRetryDelayMs,
  getTournamentOfflineResultQueueScope,
  mergeTournamentOfflineResultPayloads,
  shouldQueueTournamentResultError,
} from "./tournamentOfflineSyncPolicy";

const DB_NAME = "padlhub.lk.tournament-offline.v1";
const DB_VERSION = 1;

const PROFILE_STORE = "profiles";
const SCHEDULE_STORE = "schedules";
const HISTORY_STORE = "histories";
const QUEUE_STORE = "queue";

const MAX_BATCH_SIZE = 3;

type TournamentOfflineProfileRecord = {
  key: "current";
  profile: UserProfileType;
  updatedAt: string;
};

type TournamentOfflineScheduleRecord = {
  date: string;
  items: Exercise[];
  updatedAt: string;
};

type TournamentOfflineHistoryRecord = {
  tournamentId: string;
  history: TournamentHistoryRecord;
  updatedAt: string;
};

export interface TournamentOfflineResultQueueRecord {
  jobId: string;
  tournamentId: string;
  payload: AmericanoResultsPayload;
  attempts: number;
  nextAttemptAt: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  source: string | null;
}

export interface TournamentOfflineResultSyncResolvedItem {
  jobId: string;
  tournamentId: string;
  response: AmericanoResultsResponse;
}

export interface TournamentOfflineResultSyncFailedItem {
  jobId: string;
  tournamentId: string;
  error: string;
}

export interface TournamentOfflineResultSyncOutcome {
  processed: number;
  pending: number;
  resolved: TournamentOfflineResultSyncResolvedItem[];
  failed: TournamentOfflineResultSyncFailedItem[];
}

export interface TournamentOfflineResultSubmitOutcome {
  mode: "online" | "queued";
  response: ApiResult<AmericanoResultsResponse> | null;
  jobId?: string;
  reason?: string | null;
}

const isBrowser = typeof window !== "undefined";

function toStringSafe(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function safeArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function safeJsonClone<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function buildTimestamp() {
  return new Date().toISOString();
}

function getTournamentResultJobId(tournamentId: string, payload: AmericanoResultsPayload): string {
  const scope = getTournamentOfflineResultQueueScope(payload);
  return `${tournamentId}:${scope}`;
}

function shouldUseIndexedDb(): boolean {
  return isBrowser && typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!shouldUseIndexedDb()) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROFILE_STORE)) {
          db.createObjectStore(PROFILE_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(SCHEDULE_STORE)) {
          db.createObjectStore(SCHEDULE_STORE, { keyPath: "date" });
        }
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          db.createObjectStore(HISTORY_STORE, { keyPath: "tournamentId" });
        }
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: "jobId" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T | null> {
  const db = await openDatabase();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      transaction.onerror = () => resolve(null);
      run(store)
        .then((result) => resolve(result))
        .catch(() => {
          try {
            transaction.abort();
          } catch {
            // ignore
          }
          resolve(null);
        });
    } catch {
      resolve(null);
    }
  });
}

async function readAll<T>(storeName: string): Promise<T[]> {
  return withStore<T[]>(
    storeName,
    "readonly",
    (store) => new Promise((resolve) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(safeArray(request.result as T[]));
      request.onerror = () => resolve([]);
    }),
  ).then((result) => result ?? []);
}

async function readOne<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  return withStore<T | null>(
    storeName,
    "readonly",
    (store) => new Promise((resolve) => {
      const request = store.get(key);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => resolve(null);
    }),
  ).then((result) => result ?? null);
}

async function writeOne<T>(storeName: string, value: T): Promise<boolean> {
  const result = await withStore<boolean>(
    storeName,
    "readwrite",
    (store) => new Promise((resolve) => {
      const request = store.put(value);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    }),
  );
  return result ?? false;
}

async function deleteOne(storeName: string, key: IDBValidKey): Promise<boolean> {
  const result = await withStore<boolean>(
    storeName,
    "readwrite",
    (store) => new Promise((resolve) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    }),
  );
  return result ?? false;
}

export async function saveCachedTournamentProfile(profile: UserProfileType): Promise<void> {
  const record: TournamentOfflineProfileRecord = {
    key: "current",
    profile: safeJsonClone(profile),
    updatedAt: buildTimestamp(),
  };
  await writeOne(PROFILE_STORE, record);
}

export async function loadCachedTournamentProfile(): Promise<UserProfileType | null> {
  const record = await readOne<TournamentOfflineProfileRecord>(PROFILE_STORE, "current");
  return record?.profile ? safeJsonClone(record.profile) : null;
}

export async function saveCachedTournamentSchedule(date: string, items: Exercise[]): Promise<void> {
  const normalizedDate = toStringSafe(date);
  if (!normalizedDate) return;
  const record: TournamentOfflineScheduleRecord = {
    date: normalizedDate,
    items: safeJsonClone(items),
    updatedAt: buildTimestamp(),
  };
  await writeOne(SCHEDULE_STORE, record);
}

export async function loadCachedTournamentSchedule(date: string): Promise<Exercise[] | null> {
  const normalizedDate = toStringSafe(date);
  if (!normalizedDate) return null;
  const record = await readOne<TournamentOfflineScheduleRecord>(SCHEDULE_STORE, normalizedDate);
  return record ? safeJsonClone(record.items) : null;
}

export async function saveCachedTournamentHistory(history: TournamentHistoryRecord): Promise<void> {
  const tournamentId = toStringSafe(history?.tournamentId);
  if (!tournamentId) return;
  const record: TournamentOfflineHistoryRecord = {
    tournamentId,
    history: safeJsonClone(history),
    updatedAt: buildTimestamp(),
  };
  await writeOne(HISTORY_STORE, record);
}

export async function loadCachedTournamentHistory(tournamentId: string): Promise<TournamentHistoryRecord | null> {
  const normalizedTournamentId = toStringSafe(tournamentId);
  if (!normalizedTournamentId) return null;
  const record = await readOne<TournamentOfflineHistoryRecord>(HISTORY_STORE, normalizedTournamentId);
  return record?.history ? safeJsonClone(record.history) : null;
}

async function readPendingQueue(): Promise<TournamentOfflineResultQueueRecord[]> {
  const records = await readAll<TournamentOfflineResultQueueRecord>(QUEUE_STORE);
  return records
    .filter((record) => Boolean(record?.jobId && record?.tournamentId))
    .sort((left, right) => {
      if (left.nextAttemptAt !== right.nextAttemptAt) {
        return left.nextAttemptAt - right.nextAttemptAt;
      }
      return left.createdAt.localeCompare(right.createdAt);
    });
}

async function findPendingQueueRecordByScope(
  tournamentId: string,
  scope: string,
): Promise<TournamentOfflineResultQueueRecord | null> {
  const records = await readPendingQueue();
  return records.find((record) => (
    record.tournamentId === tournamentId
    && getTournamentOfflineResultQueueScope(record.payload) === scope
  )) ?? null;
}

export async function loadPendingTournamentResultQueue(
  tournamentId?: string | null,
): Promise<TournamentOfflineResultQueueRecord[]> {
  const normalizedTournamentId = toStringSafe(tournamentId);
  const records = await readPendingQueue();
  if (!normalizedTournamentId) return records;
  return records.filter((record) => record.tournamentId === normalizedTournamentId);
}

async function findPendingQueueRecordsByScope(
  tournamentId: string,
  scope: string,
): Promise<TournamentOfflineResultQueueRecord[]> {
  const records = await readPendingQueue();
  return records.filter((record) => (
    record.tournamentId === tournamentId
    && getTournamentOfflineResultQueueScope(record.payload) === scope
  ));
}

export async function getPendingTournamentResultSyncCount(): Promise<number> {
  const records = await readPendingQueue();
  return records.length;
}

export async function hasPendingTournamentResultJobs(tournamentId: string): Promise<boolean> {
  const normalizedTournamentId = toStringSafe(tournamentId);
  if (!normalizedTournamentId) return false;
  const records = await readPendingQueue();
  return records.some((record) => record.tournamentId === normalizedTournamentId);
}

export async function enqueuePendingTournamentResultSync(
  payload: AmericanoResultsPayload,
  options: {
    tournamentId: string;
    source?: string;
  },
): Promise<TournamentOfflineResultQueueRecord | null> {
  const tournamentId = toStringSafe(options.tournamentId);
  if (!tournamentId) return null;
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const scope = getTournamentOfflineResultQueueScope(payload);
  const previous = await findPendingQueueRecordByScope(tournamentId, scope);
  const jobId = previous?.jobId ?? getTournamentResultJobId(tournamentId, payload);
  const record: TournamentOfflineResultQueueRecord = {
    jobId,
    tournamentId,
    payload: safeJsonClone(
      (previous
        ? mergeTournamentOfflineResultPayloads(previous.payload, payload)
        : payload) as AmericanoResultsPayload,
    ),
    attempts: previous?.attempts ?? 0,
    nextAttemptAt: now,
    lastAttemptAt: previous?.lastAttemptAt ?? null,
    lastError: previous?.lastError ?? null,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    source: toStringSafe(options.source),
  };

  const saved = await writeOne(QUEUE_STORE, record);
  return saved ? record : null;
}

export async function flushPendingTournamentResultSyncJob(jobId: string): Promise<TournamentOfflineResultSyncOutcome> {
  const normalizedJobId = toStringSafe(jobId);
  if (!normalizedJobId) {
    return {
      processed: 0,
      pending: await getPendingTournamentResultSyncCount(),
      resolved: [],
      failed: [],
    };
  }

  const current = await readOne<TournamentOfflineResultQueueRecord>(QUEUE_STORE, normalizedJobId);
  if (!current) {
    return {
      processed: 0,
      pending: await getPendingTournamentResultSyncCount(),
      resolved: [],
      failed: [],
    };
  }

  const response = await apiUpdateAmericanoResults(current.payload);
  if (response.error || !response.data) {
    const message = response.error?.message || "Не удалось синхронизировать результат";
    await markPendingTournamentResultSyncFailure(current.jobId, message);
    return {
      processed: 1,
      pending: await getPendingTournamentResultSyncCount(),
      resolved: [],
      failed: [{
        jobId: current.jobId,
        tournamentId: current.tournamentId,
        error: message,
      }],
    };
  }

  await updateCachedHistoryFromResponse(current.tournamentId, response.data);
  await markPendingTournamentResultSyncResolved(current.jobId);
  return {
    processed: 1,
    pending: await getPendingTournamentResultSyncCount(),
    resolved: [{
      jobId: current.jobId,
      tournamentId: current.tournamentId,
      response: response.data,
    }],
    failed: [],
  };
}

export async function clearPendingTournamentResultQueueByPayload(
  payload: AmericanoResultsPayload,
  tournamentId: string,
): Promise<void> {
  const normalizedTournamentId = toStringSafe(tournamentId);
  if (!normalizedTournamentId) return;

  const scope = getTournamentOfflineResultQueueScope(payload);
  const records = await findPendingQueueRecordsByScope(normalizedTournamentId, scope);
  await Promise.all(records.map((record) => deleteOne(QUEUE_STORE, record.jobId)));
}

export async function clearPendingTournamentResultQueueByTournamentId(
  tournamentId: string,
): Promise<void> {
  const normalizedTournamentId = toStringSafe(tournamentId);
  if (!normalizedTournamentId) return;

  const records = await readPendingQueue();
  const matchedRecords = records.filter((record) => record.tournamentId === normalizedTournamentId);
  await Promise.all(matchedRecords.map((record) => deleteOne(QUEUE_STORE, record.jobId)));
}

export async function markPendingTournamentResultSyncFailure(
  jobId: string,
  messageRaw: string,
): Promise<void> {
  const normalizedJobId = toStringSafe(jobId);
  if (!normalizedJobId) return;
  const current = await readOne<TournamentOfflineResultQueueRecord>(QUEUE_STORE, normalizedJobId);
  if (!current) return;

  const now = Date.now();
  const attempts = (current.attempts ?? 0) + 1;
  const nextAttemptAt = now + computeTournamentOfflineRetryDelayMs(attempts);

  await writeOne(QUEUE_STORE, {
    ...current,
    attempts,
    nextAttemptAt,
    lastAttemptAt: now,
    lastError: messageRaw.trim() || "unknown",
    updatedAt: new Date(now).toISOString(),
  });
}

export async function markPendingTournamentResultSyncResolved(jobId: string): Promise<void> {
  const normalizedJobId = toStringSafe(jobId);
  if (!normalizedJobId) return;
  await deleteOne(QUEUE_STORE, normalizedJobId);
}

export async function submitTournamentResultsWithOfflineFallback(
  payload: AmericanoResultsPayload,
  options: {
    tournamentId: string;
    source?: string;
  },
): Promise<TournamentOfflineResultSubmitOutcome> {
  const isOffline = isBrowser && typeof navigator !== "undefined" && navigator.onLine === false;
  if (isOffline) {
    const queued = await enqueuePendingTournamentResultSync(payload, options);
    if (!queued) {
      return {
        mode: "online",
        response: {
          data: null,
          error: {
            status: null,
            message: "Не удалось сохранить результат локально",
          },
          status: null,
        },
      };
    }
    return {
      mode: "queued",
      response: null,
      jobId: queued?.jobId,
      reason: "offline",
    };
  }

  const response = await apiUpdateAmericanoResults(payload);
  if (response.error && shouldQueueTournamentResultError(response.error)) {
    const queued = await enqueuePendingTournamentResultSync(payload, options);
    if (!queued) {
      return {
        mode: "online",
        response: {
          data: null,
          error: {
            status: response.error.status,
            message: response.error.message || "Не удалось сохранить результат локально",
            raw: response.error.raw,
          },
          status: response.error.status,
        },
      };
    }
    return {
      mode: "queued",
      response: null,
      jobId: queued?.jobId,
      reason: response.error.message || "network_error",
    };
  }

  if (response.data) {
    await clearPendingTournamentResultQueueByPayload(payload, options.tournamentId);
  }

  return {
    mode: "online",
    response,
  };
}

async function updateCachedHistoryFromResponse(
  tournamentId: string,
  response: AmericanoResultsResponse,
): Promise<void> {
  const cachedHistory = await loadCachedTournamentHistory(tournamentId);
  if (!cachedHistory) return;

  const nextHistory: TournamentHistoryRecord = {
    ...cachedHistory,
    params: response.params && typeof response.params === "object"
      ? response.params
      : cachedHistory.params,
    rounds: Array.isArray(response.rounds) ? response.rounds : cachedHistory.rounds,
    standings: Array.isArray(response.standings) ? response.standings : cachedHistory.standings,
    summary: response.summary && typeof response.summary === "object"
      ? response.summary
      : cachedHistory.summary,
    totals: response.totals ?? cachedHistory.totals,
    playerLogs: response.playerLogs ?? cachedHistory.playerLogs,
    updatedAt: buildTimestamp(),
  };

  await saveCachedTournamentHistory(nextHistory);
}

function selectQueueItems(
  items: TournamentOfflineResultQueueRecord[],
  options: {
    forceTournamentId?: string | null;
    maxItems: number;
  },
): TournamentOfflineResultQueueRecord[] {
  const selected: TournamentOfflineResultQueueRecord[] = [];
  const normalizedForceTournamentId = toStringSafe(options.forceTournamentId);
  const now = Date.now();

  if (normalizedForceTournamentId) {
    const forced = items.find((item) => item.tournamentId === normalizedForceTournamentId);
    if (forced && forced.nextAttemptAt <= now) {
      selected.push(forced);
    }
  }

  for (const item of items) {
    if (selected.length >= options.maxItems) break;
    if (normalizedForceTournamentId && item.tournamentId === normalizedForceTournamentId) {
      continue;
    }
    if (item.nextAttemptAt > now) continue;
    selected.push(item);
  }

  return selected;
}

export async function processPendingTournamentResultSyncQueue(options?: {
  source?: string;
  forceTournamentId?: string | null;
  maxItems?: number;
  keepalive?: boolean;
}): Promise<TournamentOfflineResultSyncOutcome> {
  const queue = await readPendingQueue();
  const requestedMaxItems = options?.maxItems;
  const selected = selectQueueItems(queue, {
    forceTournamentId: options?.forceTournamentId ?? null,
    maxItems: typeof requestedMaxItems === "number" && Number.isFinite(requestedMaxItems)
      ? Math.max(1, Math.min(20, Math.floor(requestedMaxItems)))
      : MAX_BATCH_SIZE,
  });

  const resolved: TournamentOfflineResultSyncResolvedItem[] = [];
  const failed: TournamentOfflineResultSyncFailedItem[] = [];
  let processed = 0;

  for (const item of selected) {
    processed += 1;
    const response = await apiUpdateAmericanoResults(item.payload);

    if (response.error || !response.data) {
      const message = response.error?.message || "Не удалось синхронизировать результат";
      await markPendingTournamentResultSyncFailure(item.jobId, message);
      failed.push({
        jobId: item.jobId,
        tournamentId: item.tournamentId,
        error: message,
      });
      continue;
    }

    await updateCachedHistoryFromResponse(item.tournamentId, response.data);
    await markPendingTournamentResultSyncResolved(item.jobId);
    resolved.push({
      jobId: item.jobId,
      tournamentId: item.tournamentId,
      response: response.data,
    });
  }

  const pending = await getPendingTournamentResultSyncCount();
  return {
    processed,
    pending,
    resolved,
    failed,
  };
}
