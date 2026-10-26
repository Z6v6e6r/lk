import { sanitizeEvent, UUID } from "../../src/utils/errorDiagnosticsCore.mjs";
const units = ["canonical_http", "auxiliary_nginx", "node_red_events", "audit_rows", "persisted_client_error", "logical_operations", "attempts"];
// Pure parser/state transition. Caller owns a DISPOSABLE checkpoint; no active monitor imports or writes.
export function createCollector(checkpoint = {}, { capacity = 10000, ttlMs = 86400000 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400000) throw new Error("DIAGNOSTIC_COLLECTOR_LIMIT_INVALID");
  const cursors = {};
  for (const unit of units) {
    const cursor = checkpoint.cursors?.[unit];
    if (cursor && typeof cursor.inode === "string" && /^[0-9]{1,20}$/.test(cursor.inode) && Number.isSafeInteger(cursor.nextOffset) && cursor.nextOffset >= 0) cursors[unit] = { inode: cursor.inode, nextOffset: cursor.nextOffset };
  }
  const seen = new Map(Array.isArray(checkpoint.seen) ? checkpoint.seen.slice(-capacity).filter(pair => Array.isArray(pair) && pair.length === 2
    && typeof pair[0] === "string" && units.some(unit => pair[0].startsWith(`${unit}:`) && UUID.test(pair[0].slice(unit.length + 1)))
    && Number.isFinite(pair[1])) : []);
  function ingest({ source, available, inode, offset, nextOffset, fromUtc, toUtc, records = [], serverIngestTime }) {
    if (!units.includes(source)) throw new Error("DIAGNOSTIC_UNIT_UNKNOWN");
    const result = { unit: source, availability: "UNKNOWN", fromUtc: null, toUtc: null, durationSeconds: null, rate: null,
      records: null, distinctDeliveredEventIds: null, replayedRecords: null, legacyRecords: null, lateRecords: null, malformedRecords: null,
      gap: false, rotation: false, truncation: false, dedupeEvictions: 0, distinctObservedOperations: null, distinctObservedAttemptContexts: null, events: [] };
    const validTime = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    const from = validTime(fromUtc) ? Date.parse(fromUtc) : NaN, to = validTime(toUtc) ? Date.parse(toUtc) : NaN,
      ingestTime = validTime(serverIngestTime) ? Date.parse(serverIngestTime) : NaN;
    if (available !== true || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || !Number.isFinite(ingestTime)
      || typeof inode !== "string" || !/^[0-9]{1,20}$/.test(inode) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(nextOffset) || nextOffset < offset || !Array.isArray(records) || records.length > 10000) return result;
    const previous = cursors[source];
    if (!previous && offset !== 0) result.gap = true;
    if (previous && previous.inode !== inode) { result.rotation = true; result.gap = true; }
    else if (previous && offset < previous.nextOffset) { result.truncation = true; result.gap = true; }
    else if (previous && offset !== previous.nextOffset) result.gap = true;
    cursors[source] = { inode, nextOffset };
    result.availability = result.gap ? "UNKNOWN" : "AVAILABLE";
    result.fromUtc = new Date(from).toISOString(); result.toUtc = new Date(to).toISOString();
    result.durationSeconds = (to - from) / 1000;
    result.records = records.length;
    result.rate = result.gap ? null : records.length / result.durationSeconds;
    result.distinctDeliveredEventIds = 0; result.replayedRecords = 0; result.legacyRecords = 0; result.lateRecords = 0; result.malformedRecords = 0;
    for (const [id, at] of seen) if (ingestTime - at > ttlMs || at > ingestTime) seen.delete(id);
    for (const record of records) {
      let parsed;
      try { parsed = typeof record === "string" && record.length <= 8192 ? JSON.parse(record) : typeof record === "object" ? record : null; }
      catch { result.malformedRecords++; continue; }
      const input = source === "persisted_client_error" ? parsed?.payload : parsed;
      if (!input?.diagnosticEventId) { result.legacyRecords++; continue; }
      const event = sanitizeEvent(input);
      if (!event || !UUID.test(event.diagnosticEventId)) { result.malformedRecords++; continue; }
      // Delivery dedupe is bounded, per unit, and restartable; no exactly-once claim.
      if (event.legacyEvent === true) result.legacyRecords++;
      const key = `${source}:${event.diagnosticEventId}`;
      if (seen.has(key)) result.replayedRecords++;
      else { result.distinctDeliveredEventIds++; seen.set(key, ingestTime); }
      while (seen.size > capacity) { seen.delete(seen.keys().next().value); result.dedupeEvictions++; }
      const trustedEventTime = Date.parse(event.serverTimeUtc || event.serverIngestTime);
      if (Number.isFinite(trustedEventTime) && trustedEventTime < from) result.lateRecords++;
      result.events.push({ ...event, serverIngestTime });
    }
    if (source === "logical_operations" || source === "attempts") {
      const identifiers = result.events.map(event => source === "logical_operations"
        ? event.operationRef || event.logicalOperation : event.attemptReference || (event.logicalOperation && event.attempt ? `${event.logicalOperation}:${event.attempt}` : null));
      const complete = identifiers.length > 0 && identifiers.length === records.length && identifiers.every(Boolean);
      const distinct = complete ? new Set(identifiers).size : null;
      if (source === "logical_operations") result.distinctObservedOperations = distinct;
      else result.distinctObservedAttemptContexts = distinct;
      result.rate = !result.gap && distinct !== null ? distinct / result.durationSeconds : null;
    }
    return result;
  }
  return { ingest, checkpoint: () => ({ schemaVersion: 1, cursors: structuredClone(cursors), seen: [...seen] }) };
}
