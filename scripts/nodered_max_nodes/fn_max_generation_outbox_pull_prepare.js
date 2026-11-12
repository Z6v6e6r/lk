const generation = env.get('SUPPORT_MAX_GENERATION');
const after = env.get('SUPPORT_MAX_GENERATION_AFTER');
const token = env.get('SUPPORT_MAX_GENERATION_TOKEN');
const sharedToken = env.get('SUPPORT_INTEGRATION_TOKEN');
const connector = env.get('MAX_CONNECTOR');
if (!token || !['MAX_BOT', 'MAX_ACADEMY_BOT'].includes(connector)
  || typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation)
  || typeof after !== 'string' || !Number.isFinite(Date.parse(after)) || new Date(after).toISOString() !== after) return null;
const base = String(env.get('SUPPORT_API_BASE_URL') || 'http://127.0.0.1:3000/api').replace(/\/$/, '');
return { method: 'GET', url: `${base}/support/outbox/pull?connector=${connector}&limit=10&leaseSec=60`, requestTimeout: 5000,
  headers: { Accept: 'application/json', 'x-max-generation-token': token,
    ...(sharedToken ? { 'x-integration-token': sharedToken } : {}) } };
