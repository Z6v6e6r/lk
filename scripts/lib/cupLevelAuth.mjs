import { validClientId } from './cupPlayerLevel.mjs';
const fail = code => { throw new Error(code); };
/** Private child input: actor comes from a verified route or exact Bearer verification. */
export async function authorizeCupLevelInput(raw, verifyBearer) {
  if (!raw || !validClientId(raw.actorId) || !['read', 'initialize', 'verify'].includes(raw.operation)) fail('LEVEL_ARGUMENTS');
  const { authorization, _verified: ignored, ...input } = raw;
  void ignored;
  if (authorization !== undefined) {
    if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) fail('LEVEL_AUTH_REQUIRED');
    const actorId = await verifyBearer(authorization);
    if (!validClientId(actorId)) fail('LEVEL_AUTH_REQUIRED');
    input.actorId = actorId;
  } else if (input.operation === 'verify') fail('LEVEL_AUTH_REQUIRED');
  if (input.operation === 'initialize' && input.clientId !== input.actorId) fail('LEVEL_FORBIDDEN');
  return input;
}
