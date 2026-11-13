// Successful legacy SDK completion -> ACK only; no transport retry.
const command = msg.supportOutbox;
const generation = env.get('SUPPORT_MAX_GENERATION');
const after = env.get('SUPPORT_MAX_GENERATION_AFTER');
const token = env.get('SUPPORT_MAX_GENERATION_TOKEN');
const sharedToken = env.get('SUPPORT_INTEGRATION_TOKEN');
const connector = env.get('MAX_CONNECTOR');
if (typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation)
  || typeof after !== 'string' || !Number.isFinite(Date.parse(after)) || new Date(after).toISOString() !== after
  || !token || !['MAX_BOT', 'MAX_ACADEMY_BOT'].includes(connector) || command?.connector !== connector
  || typeof command.id !== 'string' || command.meta?.maxGenerationAdmission?.generation !== generation
  || command.meta?.maxGenerationAdmission?.after !== after) return null;
const base = String(env.get('SUPPORT_API_BASE_URL') || 'http://127.0.0.1:3000/api').replace(/\/$/, '');
return { method: 'POST', url: `${base}/support/outbox/${encodeURIComponent(command.id)}/ack`, requestTimeout: 5000,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-max-generation-token': token,
    ...(sharedToken ? { 'x-integration-token': sharedToken } : {}) },
  payload: {} };
