const ctx = msg._splitLeaveCtx;
// Discovery is read-only and deliberately precedes durable operation creation.
if (!ctx?.operationKey || ctx.preOperationDiscovery === true && !ctx.operationState) return [null, msg];
msg._membershipGatePayload = msg.payload;
msg.payload = { id: ctx.gameId };
return [msg, null];
