if (msg.payload?.dryRun || msg._splitCleanupRequest?.intent !== "cancel_game") return [null, msg];
msg._organizerCleanupTask = msg.payload;
msg.payload = { id: msg.payload?.gameId };
return [msg, null];
