import { createHash } from 'node:crypto';
import { identityJson, COMMUNITY_BASE } from './identity.mjs';
import { fail } from './registry.mjs';
import { eventRegistration } from '../../../scripts/lib/eventCommunity.mjs';
import { parseEventRegistrationPolicy } from '../../../src/services/community-policy.ts';
import { parseEventBinding } from './event-binding.mjs';

/** EVENT owns its one canonical form/CAS. This service never creates companion enrollment files. */
export function createEventAccess({ communityId, event, fetcher = fetch, now = () => Date.now() }) {
  const binding = parseEventBinding(event);
  if (typeof communityId !== 'string' || !/^[\p{L}\p{N}_-]{1,120}$/u.test(communityId)) fail(503, 'COMMUNITY_NOT_CONFIGURED');
  const cache = new Map(); let inflight = 0, windowAt = now(), reads = 0, queued = 0, tail = Promise.resolve();
  const tokenOf = req => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [^\s]{1,8192}$/.test(header)) fail(401, 'PROFILE_AUTH_REQUIRED');
    return header.slice(7);
  };
  const inspect = async (req, fresh = true) => {
    const token = tokenOf(req), key = createHash('sha256').update(token).digest('hex'), at = now();
    if (at >= Date.parse(binding.retentionUntil)) fail(410, 'EVENT_DATA_EXPIRED');
    for (const [id, row] of cache) if (at < row.at || at - row.at >= 30000) cache.delete(id);
    if (!fresh && cache.has(key)) return cache.get(key).value;
    if (at < windowAt || at - windowAt > 60000) { windowAt = at; reads = 0; }
    if (inflight >= 8 || ++reads > 120 || cache.size >= 256 && !cache.has(key)) fail(503, 'IDENTITY_BUSY');
    inflight++;
    try {
      const data = await identityJson(fetcher, COMMUNITY_BASE + '/lk/communities/' + encodeURIComponent(communityId) + '/event-admission', token);
      if (!data || JSON.stringify(data).length > 8192 || data.schema !== 'event-jump-admission-v1' || data.communityId !== communityId ||
          data.epoch !== binding.epoch || data.policyRevision !== binding.policyRevision || data.retentionUntil !== binding.retentionUntil ||
          !data.actor || typeof data.actor.id !== 'string' || !data.actor.id || data.actor.id.length > 120 || /[\p{C}]/u.test(data.actor.id) ||
          typeof data.actor.name !== 'string' || !data.actor.name || data.actor.name.length > 48 || /[\p{C}<>]/u.test(data.actor.name) ||
          !['ACTIVE','NONE','PENDING','BANNED'].includes(data.membership) || !['CURRENT','REQUIRED'].includes(data.registration)) fail(503, 'EVENT_ADMISSION_INVALID');
      const policy = parseEventRegistrationPolicy(data.eventNotice?.policy);
      if (data.eventNotice.revision !== binding.policyRevision || policy.startsAt !== binding.startsAt || policy.endsAt !== binding.endsAt) fail(503, 'EVENT_BINDING_CHANGED');
      const state = data.membership === 'BANNED' ? 'blocked' : data.membership === 'PENDING' ? 'pending' : at < Date.parse(binding.startsAt) ? 'scheduled' : at >= Date.parse(binding.endsAt) ? 'closed' : data.membership !== 'ACTIVE' || data.registration !== 'CURRENT' ? 'form' : 'ready';
      const value = { state, registrationKind: 'event', name: data.actor.name, communityName: typeof data.communityName === 'string' ? data.communityName.slice(0, 160) : 'Мероприятие',
        eventNotice: { policy, revision: binding.policyRevision }, actor: { id: data.actor.id, name: data.actor.name, communityId, eventEpoch: binding.epoch, policyRevision: binding.policyRevision }, membership: data.membership, registration: data.registration };
      cache.set(key, { at, value }); return value;
    } finally { inflight--; }
  };
  const publicEntry = value => ({ state: value.state, registrationKind: 'event', name: value.name, communityName: value.communityName, eventNotice: value.eventNotice });
  const authenticate = async (req, { fresh = false } = {}) => {
    const value = await inspect(req, fresh);
    if (value.membership !== 'ACTIVE') fail(403, 'COMMUNITY_MEMBER_REQUIRED');
    if (value.registration !== 'CURRENT') fail(403, 'EVENT_REGISTRATION_REQUIRED');
    return value.actor;
  };
  return { authenticate, enrollment: {
    status: async req => publicEntry(await inspect(req)),
    submit(req, body) {
      let data;
      try { data = eventRegistration(body); } catch { fail(422, 'EVENT_REGISTRATION_INVALID'); }
      if (body.policyRevision !== binding.policyRevision) fail(409, 'EVENT_BINDING_CHANGED');
      if (queued >= 12) fail(503, 'ENROLLMENT_BUSY');
      queued++; const requestedAt = now();
      const task = tail.then(async () => {
        if (now() - requestedAt > 20000) fail(503, 'ENROLLMENT_BUSY');
        const before = await inspect(req);
        if (before.state !== 'form') return publicEntry(before);
        try {
          await identityJson(fetcher, COMMUNITY_BASE + '/lk/communities/join-by-invite', tokenOf(req), { method: 'POST', timeoutMs: 8000,
            body: JSON.stringify({ inviteCode: binding.inviteCode, member: { id: before.actor.id, name: before.actor.name, role: 'MEMBER' }, eventRegistration: { ...data, policyRevision: binding.policyRevision } }) });
        } catch { /* Canonical admission, never an upstream 200, decides whether the form committed. */ }
        const after = await inspect(req);
        return { ...publicEntry(after), ...(after.state === 'form' ? { state: 'confirming' } : {}) };
      });
      tail = task.catch(() => {});
      return task.finally(() => { queued--; });
    },
  } };
}
