// Wire after normalization and BEFORE lookup, support route, callback or direct sender.
const update = msg.maxUpdate;
const generation = env.get('SUPPORT_MAX_GENERATION');
const after = env.get('SUPPORT_MAX_GENERATION_AFTER');
const token = env.get('SUPPORT_INTEGRATION_TOKEN');
const connector = env.get('MAX_CONNECTOR');
if (!['MAX_BOT', 'MAX_ACADEMY_BOT'].includes(connector) || !token || !update
  || update.providerTimestampVerified !== true || update.generation !== generation
  || typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation)
  || typeof after !== 'string' || !Number.isFinite(Date.parse(after))
  || new Date(after).toISOString() !== after || !update.messageId
  || !Number.isSafeInteger(update.timestamp) || update.timestamp <= Date.parse(after)
  || update.timestamp > Date.now() + 5000) return null;
const base = String(env.get('SUPPORT_API_BASE_URL') || 'http://127.0.0.1:3000/api').replace(/\/$/, '');
msg.method = 'POST';
msg.url = `${base}/support/max/ingress/admit`;
msg.headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-integration-token': token };
msg.payload = { connector, id: update.messageId, at: new Date(update.timestamp).toISOString() };
msg.requestTimeout = 5000;
return msg;
