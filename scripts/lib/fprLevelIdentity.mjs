const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(Boolean))];

/** Fail closed when any canonical identity alias belongs to another player. */
export async function readFprLevelIdentityHistory(db, clientId, session) {
  const options = { session, maxTimeMS: 30000 };
  const states = await db.collection('player_rating_state').find({ $or: [{ clientId }, { 'identityAliases.clientIds': clientId }] }, options).limit(3).toArray();
  if (states.length > 1) throw new Error('FPR_LEVEL_IDENTITY_CONFLICT');
  const current = states[0] || null;
  const aliases = unique([clientId, current?.clientId, ...list(current?.identityAliases?.clientIds)]);
  const phones = unique([current?.phoneNorm, ...list(current?.identityAliases?.phoneNorms)]);
  const keys = unique([current?.playerKey, ...list(current?.identityAliases?.playerKeys),
    ...aliases.map(id => `client:${id}`), ...phones.map(phone => `phone:${phone}`)]);
  const clauses = [{ 'player.clientId': { $in: aliases } }, { 'player.key': { $in: keys } }];
  for (const alias of aliases) {
    const owners = await db.collection('player_rating_state').find({ $or: [{ clientId: alias }, { 'identityAliases.clientIds': alias }] }, options).limit(3).toArray();
    if (owners.some(s => !current || String(s._id) !== String(current._id))) throw new Error('FPR_LEVEL_CLIENT_ALIAS_CONFLICT');
  }
  for (const key of keys) {
    const owners = await db.collection('player_rating_state').find({ $or: [{ playerKey: key }, { 'identityAliases.playerKeys': key }] }, options).limit(3).toArray();
    if (owners.some(s => !current || String(s._id) !== String(current._id))) throw new Error('FPR_LEVEL_KEY_ALIAS_CONFLICT');
  }
  for (const phone of phones) {
    const phoneStates = await db.collection('player_rating_state').find({ $or: [{ phoneNorm: phone }, { 'identityAliases.phoneNorms': phone }] }, options).limit(3).toArray();
    if (phoneStates.some(s => String(s._id) !== String(current._id))) throw new Error('FPR_LEVEL_PHONE_IDENTITY_CONFLICT');
  }
  if (phones.length) clauses.push({ 'player.phoneNorm': { $in: phones } });
  const events = await db.collection('rating_events').find({ $or: clauses }, options).limit(20001).toArray();
  if (events.length > 20000) throw new Error('FPR_LEVEL_HISTORY_CAP');
  return { current, aliases, phones, keys, events };
}
