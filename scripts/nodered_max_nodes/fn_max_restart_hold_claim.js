const hold = /* __MAX_HOLD_CONFIG__ */;
const input = msg.payload;
if (!input || input.windowId !== hold.windowId || input.connector !== hold.connector
  || input.confirmation !== 'DRAIN_ONE_HELD_MAX_EVENT' || Date.now() >= Date.parse(hold.acceptUntil)) return null;
const claimToken = nodeCrypto.randomUUID();
return { _maxRestartHold: { windowId: hold.windowId, connector: hold.connector, claimToken },
  payload: [{ windowId: hold.windowId, connector: hold.connector, state: 'HELD', attempts: 0 },
    { $set: { state: 'DELIVERING', claimToken, claimedAt: new Date().toISOString() }, $inc: { attempts: 1 } },
    { upsert: false, sort: { receivedAt: 1, _id: 1 }, returnDocument: 'after', includeResultMetadata: false,
      writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 } }] };
