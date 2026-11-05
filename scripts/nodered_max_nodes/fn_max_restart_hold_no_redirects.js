// Last function before each credential-bearing HTTP node; no normalizer/router can override it.
const hold = /* __MAX_HOLD_CONFIG__ */;
const claim = msg._maxRestartHold;
if (!claim || claim.windowId !== hold.windowId || claim.connector !== hold.connector
  || typeof claim.receiptId !== 'string' || typeof claim.claimToken !== 'string') return null;
msg.followRedirects = false;
msg.maxRedirects = 0;
return msg;
