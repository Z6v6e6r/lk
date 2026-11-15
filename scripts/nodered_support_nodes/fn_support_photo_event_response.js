// Preserve the durable Mongo message; expose signed delivery URLs through the shared resolver.
const payload = { ok: true, client: msg._supportEvent?.client || null,
  dialog: msg._supportEvent?.dialog || null, message: msg._supportEvent?.message || null };
return [{ _msgid: msg._msgid, req: msg.req, res: msg.res, statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, payload },
  { payload: { ok: true, messageId: payload.message?.id, attachmentCount: payload.message?.attachments?.length || 0 } }];
