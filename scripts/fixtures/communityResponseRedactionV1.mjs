// Frozen four-type sanitizer from 680d3940^; do not derive old bytes from current code.
export function sanitizeTypedCommunityPayload(value, typed = false) {
  if (Array.isArray(value)) return value.map(item => sanitizeTypedCommunityPayload(item, typed));
  if (!value || typeof value !== 'object') return value;
  const scoped = typed || ['STATION', 'CORPORATE', 'LEAGUE'].includes(value.communityType);
  const phoneIdentity = typeof value.playerKey === 'string' && value.playerKey.startsWith('phone:');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (scoped && (/phone|mobile|msisdn|^email$/i.test(key) || key === 'playerKey')) continue;
    if (scoped && (key === 'playerId' && phoneIdentity)) continue;
    if (scoped && /(?:^id$|Id$|Key$)/.test(key) && typeof item === 'string' && /(?:^phone:|(?:^|[^a-fA-F0-9])(?:\+7|8|7)\d{10}(?:$|[^a-fA-F0-9]))/.test(item)) continue;
    result[key] = sanitizeTypedCommunityPayload(item, scoped);
  }
  return result;
}
