if (!msg._organizerCleanupKey) return [null,msg];
msg._organizerCleanupPausedSummary = msg.payload;
msg.payload = [{ id: msg.payload?.gameId, "membershipMutation.operationKey": msg._organizerCleanupKey,
  "membershipMutation.executorToken": msg._organizerCleanupExecutor },
  { $set: { "membershipMutation.executorActive": false } }, { upsert: false }];
return [msg,null];
