import { createHash } from 'node:crypto';
import { fail } from './registry.mjs';

export const PROFILE = 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile';
export const COMMUNITY_BASE = 'https://padlhub.su';

export async function identityJson(fetcher, url, token, options = {}) {
  const { timeoutMs = 3000, ...request } = options;
  const response = await fetcher(url, { ...request, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(request.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 401 || response.status === 403) fail(401, 'PROFILE_AUTH_REQUIRED');
  if (!response.ok) fail(503, 'IDENTITY_UNAVAILABLE');
  const length = Number(response.headers.get('content-length')); if (Number.isFinite(length) && length > 2097152) { await response.body?.cancel(); fail(503, 'IDENTITY_RESPONSE_INVALID'); }
  const reader = response.body?.getReader(); if (!reader) fail(503, 'IDENTITY_RESPONSE_INVALID');
  const chunks = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2097152) { await reader.cancel(); fail(503, 'IDENTITY_RESPONSE_INVALID'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail(503, 'IDENTITY_RESPONSE_INVALID'); }
}

/** Uses existing read-only profile/community contracts. No guest fallback or client actor IDs. */
export function createIdentityVerifier({ communityId, fetcher = fetch, now = () => Date.now() } = {}) {
  const cache = new Map(); let inflight = 0, windowAt = now(), requests = 0;
  const inspect = async (req, { fresh = false } = {}) => {
    if (typeof communityId !== 'string' || !/^[\p{L}\p{N}_-]{1,120}$/u.test(communityId)) fail(503, 'COMMUNITY_NOT_CONFIGURED');
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [^\s]{1,8192}$/.test(header)) fail(401, 'PROFILE_AUTH_REQUIRED');
    const token = header.slice(7), key = createHash('sha256').update(token).digest('hex');
    for (const [k, v] of cache) if (now() - v.at > 30000) cache.delete(k);
    if (!fresh && cache.has(key)) return cache.get(key).value;
    if (now() - windowAt > 60000) { windowAt = now(); requests = 0; }
    if (inflight >= 8 || ++requests > 120 || cache.size >= 256 && !cache.has(key)) fail(503, 'IDENTITY_BUSY');
    inflight++;
    try {
      let profile;
      try { profile = await identityJson(fetcher, PROFILE, token); } catch (error) { error.identityStage = 'profile'; throw error; }
      const id = String(profile?.id || profile?.clientId || profile?.uuid || '').trim();
      if (!id || id.length > 120 || /[\p{C}]/u.test(id)) fail(403, 'PROFILE_INVALID');
      const url = new URL(COMMUNITY_BASE + '/lk/communities/' + encodeURIComponent(communityId)); url.searchParams.set('clientId', id);
      let data;
      try { data = await identityJson(fetcher, url.href, token); } catch (error) { error.identityStage = 'community'; throw error; }
      const community = data?.community ?? data?.data?.community ?? data?.data ?? data;
      if (!community || String(community.id) !== communityId || community.archived === true || community.membersLoaded === false || !Array.isArray(community.members)) fail(503, 'MEMBERSHIP_NOT_VERIFIED');
      if (community.bannedMembers !== undefined && !Array.isArray(community.bannedMembers) || community.pendingMembers !== undefined && !Array.isArray(community.pendingMembers)) fail(503, 'MEMBERSHIP_NOT_VERIFIED');
      const member = community.members.find(m => String(m.id ?? '') === id);
      // The live detail contract redacts pending/banned lists. A zero count
      // proves their absence; unknown/nonzero counts cannot identify this user.
      if (community.bannedMembers === undefined && community.bannedCount !== 0 || !member && community.pendingMembers === undefined && community.pendingCount !== 0) fail(503, 'MEMBERSHIP_NOT_VERIFIED');
      const banned = (community.bannedMembers ?? []).some(m => String(m.id ?? '') === id);
      const pending = member?.status === 'PENDING' || (community.pendingMembers ?? []).some(m => String(m.id ?? '') === id);
      if (member?.status && !['ACTIVE', 'PENDING'].includes(member.status)) fail(503, 'MEMBERSHIP_NOT_VERIFIED');
      const membership = banned ? 'BANNED' : pending ? 'PENDING' : member ? 'ACTIVE' : 'NONE';
      const rawName = [profile.name, profile.displayName, [profile.firstName, profile.lastName].filter(Boolean).join(' '), member?.name].find(v => typeof v === 'string' && v.trim());
      const actor = rawName ? { id, communityId, name: rawName.replace(/[\p{C}<>]/gu, '').trim().slice(0, 48) } : null;
      const value = { id, profile, actor, membership, role: member?.role, community: { id: communityId, name: community.name, inviteCode: community.inviteCode, joinRule: community.joinRule } };
      cache.set(key, { at: now(), value }); return value;
    } catch (error) { if (Number.isInteger(error.code) && error.code >= 400 && error.code <= 599) throw error; throw Object.assign(new Error('IDENTITY_UNAVAILABLE'), { code: 503, identityStage: error.identityStage }); }
    finally { inflight--; }
  };
  const authenticate = async (req, options) => {
    const value = await inspect(req, options);
    if (value.membership !== 'ACTIVE') fail(403, 'COMMUNITY_MEMBER_REQUIRED');
    if (!value.actor?.name) fail(503, 'PROFILE_NAME_MISSING');
    return value.actor;
  };
  authenticate.inspect = inspect;
  return authenticate;
}
