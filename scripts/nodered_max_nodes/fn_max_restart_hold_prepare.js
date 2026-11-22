const hold = /* __MAX_HOLD_CONFIG__ */;
const response = (statusCode, code) => msg.req ? { req: msg.req, res: msg.res,
  statusCode, headers: { 'Content-Type': 'application/json' }, payload: { ok: false, code } } : null;
try {
  if (Date.now() >= Date.parse(hold.acceptUntil)) return [null, response(503, 'MAX_HOLD_WINDOW_CLOSED')];
  const source = msg.maxUpdate;
  if (!source || source.provider !== 'max' || typeof source !== 'object') throw Error('INPUT');
  const string = (value, max = 512) => {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length > max) throw Error('FIELD');
    return value;
  };
  const integer = value => value == null ? null : Number.isSafeInteger(value) ? value : (() => { throw Error('NUMBER'); })();
  const attachments = value => {
    let count = 0;
    const visit = (v, depth) => {
      if (++count > 2048 || depth > 8) throw Error('ATTACHMENTS');
      if (v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
      if (typeof v === 'string') return string(v, 8192);
      if (Array.isArray(v)) return v.map(x => visit(x, depth + 1));
      if (typeof v !== 'object') throw Error('ATTACHMENTS');
      const out = {};
      for (const [key, item] of Object.entries(v)) {
        if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || /^(?:__proto__|constructor|prototype|raw|req|res|headers|authorization|cookie)$/i.test(key)
          || /token|secret|password/i.test(key)) throw Error('PRIVATE_FIELD');
        if (/url|href/i.test(key) && typeof item === 'string') {
          const url = new nodeUrl.URL(item);
          if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|password|signature|key/i.test(k))) throw Error('PRIVATE_URL');
        }
        out[key] = visit(item, depth + 1);
      }
      return out;
    };
    if (!Array.isArray(value)) throw Error('ATTACHMENTS');
    return visit(value, 0);
  };
  // Explicit business projection: never persist normalizer.raw/contact.raw or transport metadata.
  const update = {
    provider: 'max', updateType: string(source.updateType), timestamp: integer(source.timestamp),
    messageId: string(source.messageId), messageTimestamp: integer(source.messageTimestamp),
    text: string(source.text, 65536), command: string(source.command), buttonValue: string(source.buttonValue, 4096),
    messageKind: string(source.messageKind),
    contact: source.contact ? { phone: string(source.contact.phone), firstName: string(source.contact.firstName),
      lastName: string(source.contact.lastName), userId: string(source.contact.userId) } : null,
    station: source.station ? { id: string(source.station.id), name: string(source.station.name) } : null,
    sender: { userId: string(source.sender?.userId), username: string(source.sender?.username), name: string(source.sender?.name),
      isBot: typeof source.sender?.isBot === 'boolean' ? source.sender.isBot : null },
    recipient: { chatId: string(source.recipient?.chatId), userId: string(source.recipient?.userId), chatType: string(source.recipient?.chatType) },
    attachments: attachments(source.attachments || []),
  };
  if (!update.sender.userId && !update.recipient.chatId) throw Error('IDENTITY');
  if (Buffer.byteLength(JSON.stringify(update), 'utf8') > 262144) return [null, response(413, 'MAX_HOLD_TOO_LARGE')];
  // The normalizer can synthesize timestamps. Exclude them from duplicate-content identity.
  const content = { ...update, timestamp: null, messageTimestamp: null };
  const digest = value => nodeCrypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const receiptId = update.messageId
    ? digest([hold.windowId, hold.connector, update.messageId]) : nodeCrypto.randomUUID();
  const payloadSha256 = digest(content);
  const record = { _id: receiptId, windowId: hold.windowId, connector: hold.connector, payloadSha256,
    state: 'HELD', attempts: 0, receivedAt: new Date().toISOString(), maxUpdate: update };
  return [{ req: msg.req, res: msg.res, _maxRestartHold: { receiptId, payloadSha256 },
    payload: [{ _id: receiptId, windowId: hold.windowId, connector: hold.connector, payloadSha256 },
      { $setOnInsert: record }, { upsert: true, writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 } }] }, null];
} catch {
  return [null, response(400, 'MAX_HOLD_INPUT_REFUSED')];
}
