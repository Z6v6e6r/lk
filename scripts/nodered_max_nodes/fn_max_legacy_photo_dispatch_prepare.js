const command = msg.payload;
if (!command || typeof command !== 'object' || Array.isArray(command) ||
  (!command.targetExternalChatId && !command.targetExternalUserId) ||
  (!String(command.text || '').trim() && !(Array.isArray(command.attachments) && command.attachments.length))) {
  return [null, { payload: { code: 'MAX_OUTBOX_INVALID_COMMAND' } }];
}
// The controlled legacy sender validates the original durable claim, including all photos.
// No formatter, attachment conversion or user/chat fallback can discard part of the message here.
return [{ supportOutbox: command }, null];
