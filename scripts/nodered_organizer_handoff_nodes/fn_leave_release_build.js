const ctx = msg._splitLeaveCtx;
if (!ctx?.operationKey) return [null, msg];
msg._membershipReleasePayload = msg.payload;
msg.payload = [{ id: ctx.gameId, "membershipMutation.operationKey": ctx.operationKey },
  { $unset: { membershipMutation: "" } }, { upsert: false }];
return [msg, null];
