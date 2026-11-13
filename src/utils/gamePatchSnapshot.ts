import type { PadelGameRecord } from './apiClient';

const key = Symbol.for('padlhub.gamePatchSnapshot.v1');
type Kind = 'canonical' | 'partial_ack';
type Version = Pick<PadelGameRecord, 'updatedAt' | 'revision'>;
type Metadata = { kind: Kind; acknowledged?: Version };
type Marked = PadelGameRecord & { [key]?: Metadata };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const own = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);

function rawRecord(value: unknown, id: string, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    const matches = value.map(row => rawRecord(row, id, depth + 1)).filter(row => row !== null);
    return matches.length === 1 ? matches[0] : null;
  }
  if (!object(value)) return null;
  const actualId = value.id ?? value.gameId ?? value.recordId ?? value.uuid;
  if (typeof actualId === 'string') {
    if (actualId.trim() !== id) return null;
    return { ...(object(value.data) ? value.data : {}), ...value };
  }
  for (const name of ['data', 'record', 'game', 'payload', 'result']) {
    const found = rawRecord(value[name], id, depth + 1);
    if (found) return found;
  }
  return null;
}

export function gamePatchSnapshotKind(record: PadelGameRecord | null | undefined): Kind | null {
  const kind = (record as Marked | null | undefined)?.[key]?.kind;
  return kind === 'canonical' || kind === 'partial_ack' ? kind : null;
}

function mark(record: PadelGameRecord, kind: Kind, acknowledged?: Version): PadelGameRecord {
  Object.defineProperty(record, key, { value: { kind, acknowledged }, enumerable: false });
  return record;
}

// Field presence is checked before the normalizer can fabricate empty arrays.
export function gamePatchSnapshot(raw: unknown, normalized: PadelGameRecord, id: string, kind: Kind): PadelGameRecord | null {
  const source = rawRecord(raw, id);
  if (!source || normalized.id !== id) return null;
  if (kind === 'canonical') {
    const participants = source.participants ?? source.players;
    const waitlist = source.waitlist ?? source.waitingList;
    const updatedAtKnown = own(source, 'updatedAt') && (source.updatedAt === null || (typeof source.updatedAt === 'string' && Number.isFinite(Date.parse(source.updatedAt))));
    const revisionKnown = own(source, 'revision') && Number.isSafeInteger(source.revision) && (source.revision as number) >= 0;
    if (!Array.isArray(participants) || !Array.isArray(waitlist) || (!updatedAtKnown && !revisionKnown)) return null;
    return mark({ ...normalized }, kind);
  }
  const fields = new Set(Object.keys(source));
  for (const [alias, field] of [['players', 'participants'], ['waitingList', 'waitlist'], ['inviteLink', 'inviteUrl'], ['inviteUrl', 'inviteUrl']]) {
    if (own(source, alias)) fields.add(field);
  }
  // An ACK may describe accepted fields, but cannot pair its new revision with
  // an incomplete old roster. Only a full GET may advance the local version.
  fields.delete('updatedAt'); fields.delete('revision');
  const versionKnown = Number.isSafeInteger(normalized.revision) || Number.isFinite(Date.parse(normalized.updatedAt ?? ''));
  if (!versionKnown) fields.clear();
  const partial = Object.fromEntries(Object.entries(normalized).filter(([name]) => name === 'id' || fields.has(name))) as unknown as PadelGameRecord;
  return mark(partial, kind, { updatedAt: normalized.updatedAt, revision: normalized.revision });
}

function older(incoming: Version, current: Version): boolean {
  if (Number.isSafeInteger(incoming.revision) && Number.isSafeInteger(current.revision) && incoming.revision !== current.revision) {
    return (incoming.revision as number) < (current.revision as number);
  }
  const next = Date.parse(incoming.updatedAt ?? ''), previous = Date.parse(current.updatedAt ?? '');
  return Number.isFinite(next) && Number.isFinite(previous) && next < previous;
}

function comparable(incoming: Version | undefined, current: Version): boolean {
  return Boolean(incoming && (
    (Number.isSafeInteger(incoming.revision) && Number.isSafeInteger(current.revision))
    || (Number.isFinite(Date.parse(incoming.updatedAt ?? '')) && Number.isFinite(Date.parse(current.updatedAt ?? '')))
  ));
}

function versionKnown(value: Version | undefined): boolean {
  return Boolean(value && (Number.isSafeInteger(value.revision) || Number.isFinite(Date.parse(value.updatedAt ?? ''))));
}

export function applyGamePatchSnapshot(current: PadelGameRecord | null | undefined, incoming: PadelGameRecord): PadelGameRecord | null {
  if (current?.id !== incoming.id) current = null;
  const kind = gamePatchSnapshotKind(incoming);
  if (!kind) return null;
  const acknowledged = (incoming as Marked)[key]?.acknowledged;
  const previousAck = (current as Marked | null | undefined)?.[key]?.acknowledged;
  const nextVersion = kind === 'canonical' ? incoming : acknowledged;
  if (current && nextVersion && (older(nextVersion, current) || (previousAck && older(nextVersion, previousAck)))) return current;
  if (kind === 'canonical' && ((versionKnown(current ?? undefined) && !comparable(incoming, current!))
    || (versionKnown(previousAck) && !comparable(incoming, previousAck!)))) return current ?? null;
  // An ACK without a comparable version cannot overwrite a newer independently
  // fetched snapshot. Its acceptance still stops workflow replay.
  if (kind === 'partial_ack' && current && !comparable(acknowledged, current)) {
    return mark({ ...current }, kind, versionKnown(acknowledged) ? acknowledged : previousAck);
  }
  return mark(kind === 'canonical' ? { ...incoming } : { ...current, ...incoming }, kind, acknowledged ?? previousAck);
}

export const GAME_PATCH_SNAPSHOT_EVENT = 'padlhub:game-patch-snapshot:v1';
export function publishGamePatchSnapshot(record: PadelGameRecord): void {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(GAME_PATCH_SNAPSHOT_EVENT, { detail: { record } })); }
  catch { /* A consumer failure cannot change an accepted write. */ }
}

export const GAME_PATCH_PENDING_MESSAGE = 'Изменения сохранены. Актуальное состояние пока недоступно — обновите данные игры.';
