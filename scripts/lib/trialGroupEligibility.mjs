// Catalogue evidence: Viva type 1755, direction 4971. Activation still requires
// fresh catalogue/history evidence; absent configuration leaves enforcement off.
export const TRIAL_GROUP_TYPE_ID = 1755;
export const TRIAL_GROUP_DIRECTION_ID = 4971;
export const TRIAL_GROUP_POLICY_GLOBAL = 'trial_group_visit_policy';
export const TRIAL_GROUP_HISTORY_CONTRACT = 'viva-self-history-attendance-v1';

export function trialRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function trialId(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}
export function isTrialGroupExercise(exercise) {
  if (!trialRecord(exercise)) return false;
  const types = [exercise.type?.id, exercise.exerciseType?.id, exercise.typeId, exercise.exerciseTypeId,
    typeof exercise.type !== 'object' ? exercise.type : undefined];
  const directions = [exercise.direction?.id, exercise.exerciseDirection?.id, exercise.directionId,
    exercise.exerciseDirectionId, typeof exercise.direction !== 'object' ? exercise.direction : undefined];
  return types.some(value => trialId(value) === String(TRIAL_GROUP_TYPE_ID))
    || directions.some(value => trialId(value) === String(TRIAL_GROUP_DIRECTION_ID));
}
export function normalizeTrialGroupPolicy(value) {
  if (value === undefined || value === null) return { mode: 'off', version: 'trial-group-v1' };
  if (!trialRecord(value) || !['off', 'shadow', 'enforce'].includes(value.mode)
    || value.version !== 'trial-group-v1'
    || (value.mode !== 'off' && value.historyContract !== TRIAL_GROUP_HISTORY_CONTRACT)) {
    return { code: 'TRIAL_TRAINING_POLICY_UNVERIFIED' };
  }
  return { mode: value.mode, version: value.version };
}
export function trialVisitWindow(requestedAt) {
  const instant = Date.parse(requestedAt);
  if (!Number.isFinite(instant)) throw new Error('Invalid server request time');
  // Modern Moscow uses UTC+03; retain local wall-clock time and clamp month ends.
  const local = new Date(instant + 3 * 60 * 60 * 1000);
  const month = local.getUTCMonth() - 6;
  const lastDay = new Date(Date.UTC(local.getUTCFullYear(), month + 1, 0)).getUTCDate();
  const from = Date.UTC(local.getUTCFullYear(), month, Math.min(local.getUTCDate(), lastDay),
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds())
    - 3 * 60 * 60 * 1000;
  return { from: new Date(from).toISOString(), to: new Date(instant).toISOString(),
    timeZone: 'Europe/Moscow', months: 6 };
}
// Reject owner echoes that conflict with the authenticated self-history request.
export function trialOwnerMatches(row, actorId) {
  const owners = [row.clientId, row.userId, row.playerId, row.client?.id, row.client?.clientId]
    .filter(value => value !== undefined);
  return Boolean(actorId) && owners.every(value => typeof value === 'string' && value === actorId);
}
export function trialHistoryPage(payload, expectedPage, expectedTotal, expectedTotalPages) {
  if (!trialRecord(payload) || !Array.isArray(payload.content)
    || !Number.isSafeInteger(payload.number) || payload.number !== expectedPage
    || !Number.isSafeInteger(payload.totalElements) || payload.totalElements < 0
    || !Number.isSafeInteger(payload.totalPages) || payload.totalPages < 0
    || (expectedTotalPages !== undefined && expectedTotalPages !== payload.totalPages)
    || typeof payload.last !== 'boolean'
    || (expectedTotal !== undefined && expectedTotal !== payload.totalElements)
    || payload.content.length > 1000 || payload.totalPages > 100
    || (payload.totalPages > 0 && expectedPage >= payload.totalPages)
    || payload.last !== (payload.totalPages === 0 || expectedPage === payload.totalPages - 1)
    || (!payload.last && payload.content.length === 0)
    || (payload.totalPages === 0 && (payload.content.length !== 0 || payload.totalElements !== 0))) {
    return { code: 'TRIAL_TRAINING_HISTORY_INCOMPLETE' };
  }
  return { rows: payload.content, last: payload.last, total: payload.totalElements, totalPages: payload.totalPages };
}
export function trialVisitTime(row) {
  const exercise = trialRecord(row.exercise) ? row.exercise : {};
  const raw = exercise.timeTo ?? row.timeToIso ?? row.timeTo ?? row.endedAt;
  const date = exercise.date ?? row.exerciseDate ?? row.date;
  const text = typeof raw === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(raw)
    && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? `${date}T${raw.length === 5 ? raw + ':00' : raw}+03:00` : raw;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return NaN;
  const [year, month, day] = text.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  return Date.parse(text);
}
export function trialAttendance(row) {
  const flags = [row.visitConfirmed, row.visited, row.attended, row.checkedIn, row.present]
    .filter(value => value !== undefined && value !== null);
  if (flags.some(value => typeof value !== 'boolean')) return null;
  const statuses = [row.status, row.bookingStatus, row.registrationStatus]
    .filter(value => typeof value === 'string').map(value => value.toUpperCase());
  const negative = row.isCancelled === true || row.cancelled === true || row.canceled === true
    || statuses.some(value => /^(CANCELLED|CANCELED|NO_SHOW|NOT_VISITED|DELETED|WAITLIST)$/.test(value));
  const positive = flags.includes(true) || statuses.some(value => /^(ATTENDED|VISITED|VISIT_CONFIRMED|CHECKED_IN)$/.test(value));
  if (positive && (negative || flags.includes(false))) return null;
  if (positive) return true;
  if (negative || flags.includes(false)) return false;
  // PAID, COMPLETED and REFUNDED are not attendance evidence.
  return null;
}
export function evaluateTrialGroupVisits({ rows, actorId, requestedAt }) {
  const window = trialVisitWindow(requestedAt);
  const from = Date.parse(window.from), to = Date.parse(window.to);
  const visits = new Map();
  for (const row of rows) {
    if (!trialRecord(row) || !trialOwnerMatches(row, actorId)) return { code: 'TRIAL_TRAINING_HISTORY_IDENTITY_UNVERIFIED' };
    const at = trialVisitTime(row);
    if (!Number.isFinite(at)) return { code: 'TRIAL_TRAINING_ATTENDANCE_UNVERIFIED' };
    if (at < from || at >= to) continue;
    const attended = trialAttendance(row);
    const eventId = trialId(row.exercise?.id ?? row.exerciseId);
    if (attended === null || !eventId) return { code: 'TRIAL_TRAINING_ATTENDANCE_UNVERIFIED' };
    const fact = `${at}:${attended}`;
    if (visits.has(eventId) && visits.get(eventId) !== fact) return { code: 'TRIAL_TRAINING_ATTENDANCE_UNVERIFIED' };
    visits.set(eventId, fact);
  }
  const count = [...visits.values()].filter(fact => fact.endsWith(':true')).length;
  return { eligible: count <= 2, count, maxVisits: 2, window,
    code: count > 2 ? 'TRIAL_TRAINING_VISIT_LIMIT_EXCEEDED' : null };
}
