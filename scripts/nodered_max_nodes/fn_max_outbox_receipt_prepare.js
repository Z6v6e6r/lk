const receipt = msg.maxOutboxReceipt;
if (!receipt || typeof receipt.id !== 'string' || typeof receipt.leaseToken !== 'string'
  || !['ack', 'fail'].includes(receipt.kind)) return null;
const base = String(env.get('SUPPORT_API_BASE_URL') || 'http://127.0.0.1:3000/api').replace(/\/+$/, '');
const token = env.get('SUPPORT_INTEGRATION_TOKEN');
const payload = { leaseToken: receipt.leaseToken };
if (receipt.kind === 'fail') {
  payload.failure = receipt.failure;
  if (Number.isFinite(receipt.retryAfterSeconds)) payload.retryAfterSeconds = receipt.retryAfterSeconds;
}
return { method: 'POST', url: `${base}/support/outbox/${encodeURIComponent(receipt.id)}/${receipt.kind}`,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json',
    ...(token ? { 'x-integration-token': token } : {}) }, payload };
