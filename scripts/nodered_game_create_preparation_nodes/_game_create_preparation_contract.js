// Private nonbinding price observation. Never a reservation or eligibility proof.
const gcObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const gcKeys = (v, keys) =>
  gcObject(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const gcId = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v) && !/[\r\n]/.test(v);
const gcUuid = (v) => typeof v === 'string' && v.length === 36 && BOOKED_OP_UUID.test(v);
const gcHash = (v) => bookedOperationSha256(v);
const gcDigest = (v) => typeof v === 'string' && v.length === 71 && BOOKED_OP_SHA256.test(v);
const gcIso = (v) => typeof v === 'string' && v.length === 24 && bookedOperationIsCanonicalIso(v);
const gcPath = '/lk/integrations/v1/game-create-preparations';
const gcMoscow = (v) => new Date(Date.parse(v) + 180 * 60000).toISOString();
const gcOperationId = (c) => {
  const chars = gcHash(
    'booked-operation-admission:v1\0lk2-api\0' +
      c.tenant_id +
      '\0' +
      c.sub +
      '\0' +
      c.idempotency_key_sha256,
  )
    .slice(7, 39)
    .split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const s = chars.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
const gcRequest = (v) => {
  if (
    !gcKeys(v, 'contractVersion,action,subscriptionId,target') ||
    v.contractVersion !== 1 ||
    v.action !== 'CREATE_GAME' ||
    !gcUuid(v.subscriptionId) ||
    !gcKeys(v.target, 'draftId,expectedRevision,stationId,courtId,startsAt,durationMinutes')
  )
    return null;
  const t = v.target;
  if (
    ![t.draftId, t.stationId, t.courtId].every(gcUuid) ||
    !Number.isSafeInteger(t.expectedRevision) ||
    t.expectedRevision < 1 ||
    !gcIso(t.startsAt) ||
    !Number.isSafeInteger(t.durationMinutes) ||
    t.durationMinutes < 1 ||
    t.durationMinutes > 1440 ||
    Date.parse(t.startsAt) % 60000 !== 0
  )
    return null;
  const endsAt = new Date(Date.parse(t.startsAt) + t.durationMinutes * 60000).toISOString();
  if (gcMoscow(t.startsAt).slice(0, 10) !== gcMoscow(endsAt).slice(0, 10)) return null;
  return {
    contractVersion: 1,
    action: 'CREATE_GAME',
    subscriptionId: v.subscriptionId,
    target: {
      draftId: t.draftId,
      expectedRevision: t.expectedRevision,
      stationId: t.stationId,
      courtId: t.courtId,
      startsAt: t.startsAt,
      durationMinutes: t.durationMinutes,
    },
  };
};
// Arrays are complete list responses; paginated responses must explicitly prove one complete page.
const gcList = (p) => {
  if (Array.isArray(p)) return p.length <= 1000 && p.every(gcObject) ? p : null;
  if (
    !gcObject(p) ||
    !Array.isArray(p.content) ||
    p.content.length > 1000 ||
    !p.content.every(gcObject) ||
    p.number !== 0 ||
    p.last !== true ||
    p.totalElements !== p.content.length ||
    ![0, 1].includes(p.totalPages) ||
    p.hasNext === true
  )
    return null;
  return p.content;
};
const gcAlias = (v, keys) => {
  if (!gcObject(v)) return null;
  const values = keys.filter((k) => Object.hasOwn(v, k)).map((k) => v[k]);
  return values.length && values.every(gcId) && new Set(values).size === 1 ? values[0] : null;
};
const gcReject = (msg, status, code) => {
  msg.statusCode = status;
  msg.payload = { code, error: code };
  return msg;
};
