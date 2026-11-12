// Frozen sanitizer before the binary logo/cache repair.
export function sanitizeTypedCommunityPayload(value, typed = false) {
  if (Array.isArray(value)) return value.map(item => sanitizeTypedCommunityPayload(item, typed));
  if (!value || typeof value !== 'object') return value;
  const scoped = typed || ['STATION', 'CORPORATE', 'LEAGUE', 'EVENT'].includes(value.communityType);
  const phoneIdentity = typeof value.playerKey === 'string' && value.playerKey.startsWith('phone:');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['stationMembershipLifetime', 'stationMembershipAdmission', 'admissionBindingSha256', 'communityMessageOutbox', 'stationMessageEvent', 'stationMessageOwner'].includes(key)) continue;
    if (key === 'eventEntries' || key === 'eventRegistration' || key === '_eventEntry') continue;
    if (scoped && (/phone|mobile|msisdn|^email$/i.test(key) || key === 'playerKey')) continue;
    if (scoped && (key === 'playerId' && phoneIdentity)) continue;
    if (scoped && /(?:^id$|Id$|Key$)/.test(key) && typeof item === 'string' && /(?:^phone:|(?:^|[^a-fA-F0-9])(?:\+7|8|7)\d{10}(?:$|[^a-fA-F0-9]))/.test(item)) continue;
    result[key] = sanitizeTypedCommunityPayload(item, scoped);
  }
  return result;
}
