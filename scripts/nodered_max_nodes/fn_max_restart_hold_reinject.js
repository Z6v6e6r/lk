const hold = /* __MAX_HOLD_CONFIG__ */;
const record = msg.payload, claim = msg._maxRestartHold;
// Ambiguous claim writes are retained as DELIVERING; a manual mark-unknown can classify them.
// Never redispatch on a failed/unknown result or replay a supplied document directly.
if (msg.error || !record || !claim || record.windowId !== hold.windowId || record.connector !== hold.connector
  || claim.windowId !== hold.windowId || claim.connector !== hold.connector
  || record.state !== 'DELIVERING' || record.attempts !== 1 || record.claimToken !== claim.claimToken
  || typeof record._id !== 'string' || !/^(?:[0-9a-f]{64}|[0-9a-f-]{36})$/.test(record._id)
  || record.maxUpdate?.provider !== 'max') return null;
const content = { ...record.maxUpdate, timestamp: null, messageTimestamp: null };
if (nodeCrypto.createHash('sha256').update(JSON.stringify(content)).digest('hex') !== record.payloadSha256) return null;
return { maxUpdate: record.maxUpdate, payload: record.maxUpdate, requestTimeout: 10000, followRedirects: false, maxRedirects: 0,
  _maxRestartHold: { windowId: hold.windowId, connector: hold.connector, receiptId: record._id, claimToken: claim.claimToken } };
