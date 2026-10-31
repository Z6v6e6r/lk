// Ports: admission find/update, community find/update, generation find/update, response.
const ctx = msg._stationMembership;
const output = (port, payload, step) => {
  if (step) ctx.step = step;
  msg.payload = payload; delete msg.error; delete msg.statusCode;
  const values = Array(7).fill(null); values[port] = msg; return values;
};
const fail = (status, code) => { const values = Array(7).fill(null); values[6] = smFailure(msg, status, code); return values; };
const done = (outcome, reason) => {
  const result = { contractVersion: 1, operationId: ctx.request.operationId, outcome, reason };
  const values = Array(7).fill(null); values[6] = smResponse(msg, 200, result); return values;
};
const readAdmission = step => output(0, [{ _id: smAdmissionKey(ctx.actor, ctx.request.operationId) }, { limit: 2 }], step);
const readCommunity = step => output(2, [{ communityType: 'STATION', archived: { $ne: true }, 'typeSettings.stationId': ctx.admission?.stationId || ctx.request.stationId }, { limit: 2 }], step);
const readClaim = () => output(4, [{ _id: ctx.claim._id }, { limit: 2 }], 'claim_read');
try {
  if (!ctx || env.get(SM_FLAG) !== 'true') return fail(503, 'STATION_MEMBERSHIP_DISABLED');
  // A write error or ambiguous ACK always recovers by exact readback. No second blind insert.
  if (ctx.step === 'admission_write') return readAdmission('admission_readback');
  if (ctx.step === 'claim_write') return readClaim();
  if (ctx.step === 'community_write') {
    ctx.writeAmbiguous = Boolean(msg.error) || msg.payload?.acknowledged !== true;
    ctx.writeMatched = !ctx.writeAmbiguous && msg.payload.matchedCount === 1;
    return readCommunity('community_readback');
  }
  if (msg.error || !Array.isArray(msg.payload)) return fail(503, 'STATION_MEMBERSHIP_STORE_UNAVAILABLE');
  const rows = msg.payload;
  if (ctx.step === 'admission_read' || ctx.step === 'admission_readback') {
    if (!rows.length) {
      if (ctx.mode === 'confirmation') return done('NOT_ENROLLED', 'ADMISSION_MISSING');
      if (ctx.step === 'admission_readback') return fail(503, 'STATION_ADMISSION_WRITE_UNPROVEN');
      return readCommunity('admission_select');
    }
    if (rows.length !== 1 || !smValidAdmission(rows[0], ctx.actor, ctx.request.operationId)) return fail(409, 'STATION_ADMISSION_BINDING_CONFLICT');
    const d = rows[0]; ctx.admission = d;
    if (ctx.mode === 'admission') {
      if (!smEqual(smAdmissionBinding(ctx.actor, ctx.request), { contractVersion: d.contractVersion, actor: d.actor, operationId: d.operationId, requestSha256: d.requestSha256, activity: d.activity, stationId: d.stationId })) return fail(409, 'STATION_ADMISSION_BINDING_CONFLICT');
      const { outcome, admissionId, communityId, membershipEpoch, reason, bindingSha256 } = d;
      const body = { contractVersion: 1, operationId: d.operationId, admission: { outcome, admissionId, communityId, membershipEpoch, reason, bindingSha256 }, replayed: !ctx.newAdmission };
      const values = Array(7).fill(null); values[6] = smResponse(msg, 200, body); return values;
    }
    if (d.admissionId !== ctx.request.admissionId || d.bindingSha256 !== ctx.request.admissionBindingSha256 || d.activity.id !== ctx.request.confirmation.activityId) return fail(409, 'STATION_CONFIRMATION_BINDING_CONFLICT');
    if (d.outcome !== 'ADMITTED') return done('NOT_ENROLLED', d.reason);
    ctx.claim = smClaim(d, ctx.request);
    return output(5, [{ _id: ctx.claim._id }, { $setOnInsert: ctx.claim }, { upsert: true }], 'claim_write');
  }
  if (ctx.step === 'admission_select') {
    const d = smAdmission(rows, ctx.actor, ctx.request); ctx.newAdmission = true;
    return output(1, [{ _id: d._id }, { $setOnInsert: d }, { upsert: true }], 'admission_write');
  }
  if (ctx.step === 'claim_read') {
    if (rows.length !== 1) return fail(503, 'STATION_GENERATION_CLAIM_UNPROVEN');
    if (!smEqual(rows[0], ctx.claim)) return done('NOT_ENROLLED', 'GENERATION_ALREADY_CLAIMED');
    return readCommunity('community_select');
  }
  if (ctx.step === 'community_select' || ctx.step === 'community_readback') {
    const decision = smConfirmation(rows, ctx.admission, ctx.claim);
    if (decision.reason === 'ALREADY_APPLIED') return done(ctx.step === 'community_readback' ? 'ENROLLED' : 'ALREADY_APPLIED', 'CONFIRMED_MEMBERSHIP');
    if (decision.reason !== 'APPLY') return done('NOT_ENROLLED', decision.reason);
    if (ctx.step === 'community_readback' && (ctx.writeAmbiguous || ctx.writeMatched)) return fail(503, 'STATION_MEMBERSHIP_WRITE_UNPROVEN');
    if (++ctx.retries > 3) return fail(409, 'STATION_MEMBERSHIP_CAS_CONFLICT');
    return output(3, [decision.filter, decision.update, { upsert: false }], 'community_write');
  }
  return fail(503, 'STATION_MEMBERSHIP_STATE_INVALID');
} catch { return fail(503, 'STATION_MEMBERSHIP_STATE_INVALID'); }
