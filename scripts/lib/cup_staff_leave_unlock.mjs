// The error response remains the error response. Release only the lock acquired
// by this exact claim, even when a newer retry owns the same leave operation.
export function prepareStaffDiscoveryUnlock(msg) {
  const ctx = msg._splitLeaveCtx;
  delete msg._splitLeaveCtx;
  if (ctx?.mode !== 'STAFF_TARGET' || !ctx.bookingDiscovery || !ctx.gameId || !ctx.operationKey
    || !ctx.bookingDiscoveryLockClaim || ctx.bookingDiscoveryLockClaim !== ctx.claimToken) return [null, msg];
  msg._staffDiscoveryFailure = { statusCode: msg.statusCode, payload: msg.payload };
  msg.payload = [
    { id: ctx.gameId, 'membershipMutation.operationKey': ctx.operationKey,
      'membershipMutation.staffDiscoveryClaim': ctx.bookingDiscoveryLockClaim },
    { $unset: { membershipMutation: '' } },
    { upsert: false },
  ];
  return [msg, null];
}

export function finishStaffDiscoveryUnlock(msg) {
  const failure = msg._staffDiscoveryFailure;
  delete msg._staffDiscoveryFailure;
  if (!failure || msg.error || msg.payload?.acknowledged !== true) {
    msg.statusCode = 202;
    msg.payload = {
      ...failure?.payload, ok: true, status: 'RETRY_REQUIRED', state: 'RETRY_REQUIRED',
      message: 'Состояние отмены проверяется. Обновите статус удаления.',
    };
    return msg;
  }
  msg.statusCode = failure.statusCode;
  msg.payload = failure.payload;
  return msg;
}
