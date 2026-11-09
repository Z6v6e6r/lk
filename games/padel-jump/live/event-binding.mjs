import { eventRetentionUntil } from '../../../src/services/community-policy.ts';

/** Per-instance identity/policy fence, shared by admission and durable game results. */
export function parseEventBinding(value) {
  const keys = ['epoch', 'policyRevision', 'startsAt', 'endsAt', 'retentionUntil', 'inviteCode'];
  const iso = text => typeof text === 'string' && Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) ||
      !['epoch', 'startsAt', 'endsAt', 'retentionUntil'].every(key => iso(value[key])) || value.startsAt >= value.endsAt ||
      !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1 || value.retentionUntil !== eventRetentionUntil(value.endsAt) ||
      typeof value.inviteCode !== 'string' || !/^[\p{L}\p{N}_-]{1,160}$/u.test(value.inviteCode)) throw Object.assign(new Error('EVENT_BINDING_INVALID'), { code: 503 });
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}
