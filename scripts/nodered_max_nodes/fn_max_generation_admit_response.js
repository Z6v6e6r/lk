// No retry: duplicate, timeout, malformed or unknown admission stops this event.
let result = msg.payload;
if (typeof result === 'string') { try { result = JSON.parse(result); } catch { return null; } }
const generation = env.get('SUPPORT_MAX_GENERATION');
const after = env.get('SUPPORT_MAX_GENERATION_AFTER');
const connector = env.get('MAX_CONNECTOR');
if (msg.statusCode < 200 || msg.statusCode >= 300 || !Number.isInteger(msg.statusCode)
  || !['MAX_BOT', 'MAX_ACADEMY_BOT'].includes(connector) || !result || result.connector !== connector || result.generation !== generation || result.after !== after
  || typeof result.admissionId !== 'string' || !/^ingress:[a-f0-9]{64}$/.test(result.admissionId)) return null;
msg.maxIngressAdmission = { admissionId: result.admissionId, connector, generation, after };
// Do not carry the integration credential into sender/debug branches.
delete msg.headers;
return msg;
