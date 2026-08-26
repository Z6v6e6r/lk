const deferred = msg._resultVivaSyncDeferred || null;
if (!deferred) return [null, msg];
const joinMsg = msg._resultVivaSyncBatch ? Object.assign({}, msg, { payload: deferred.joinPayload }) : null;
const summaryMsg = Object.assign({}, msg, { payload: deferred.joinPayload });
return [joinMsg, summaryMsg];
