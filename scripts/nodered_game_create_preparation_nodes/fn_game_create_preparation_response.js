// No incoming credential, raw provider response or private execution context leaves this node.
bookedOperationScrubDelegation(msg);
for (const key of [
  '_gameCreatePreparation',
  'error',
  'method',
  'url',
  'responseUrl',
  'requestTimeout',
  'followRedirects',
  'maxRedirects',
])
  delete msg[key];
msg.headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};
return msg;
