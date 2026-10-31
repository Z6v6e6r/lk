// Preserve the ordinary SELF HTTP response. The internal owner caller must read
// durable SELF + CUP receipts instead of trusting this transport response body.
if (msg._managedSelfLeave) return [msg, null];
return [null, msg];
