const hold = /* __MAX_HOLD_CONFIG__ */;
const claim = msg._maxRestartHold;
if (!claim || claim.windowId !== hold.windowId || claim.connector !== hold.connector) return [null, null];
if (msg.error || !Number.isInteger(msg.statusCode) || msg.statusCode < 200 || msg.statusCode >= 300
  || !msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) {
  return [null, { _maxRestartHold: claim, _maxRestartHoldOutcome: 'UNKNOWN', _maxRestartHoldReason: 'LOOKUP_UNCONFIRMED' }];
}
return [msg, null];
