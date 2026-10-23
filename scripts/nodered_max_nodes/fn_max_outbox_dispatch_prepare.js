const command = msg.payload;
if (!command || typeof command !== 'object' || Array.isArray(command)
  || typeof command.id !== 'string') {
  return [null, { payload: { code: 'MAX_OUTBOX_INVALID_COMMAND' } }];
}
// The controlled sender owns validation and emits a fail receipt for bad target/text.
return [{ supportOutbox: command }, null];
