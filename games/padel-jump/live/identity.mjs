import { createHash } from 'node:crypto';
import { fail } from './registry.mjs';

const PROFILE = 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile';
const COMMUNITY_BASE = 'https://padlhub.su';

/** Uses existing read-only profile/community contracts. No guest fallback or client actor IDs. */
export function createIdentityVerifier({ communityId, fetcher = fetch, now = () => Date.now() } = {}) {
  const cache = new Map(); let inflight = 0, windowAt = now(), requests = 0;
  async function json(url, token) {
    const response = await fetcher(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (response.status === 401 || response.status === 403) fail(401, 'PROFILE_AUTH_REQUIRED');
    if (!response.ok) fail(503, 'IDENTITY_UNAVAILABLE');
    const length = Number(response.headers.get('content-length')); if (Number.isFinite(length) && length > 2097152) { await response.body?.cancel(); fail(503, 'IDENTITY_RESPONSE_INVALID'); }
    const reader = response.body?.getReader(); if (!reader) fail(503, 'IDENTITY_RESPONSE_INVALID');
    const chunks = []; let size = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2097152) { await reader.cancel(); fail(503, 'IDENTITY_RESPONSE_INVALID'); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail(503, 'IDENTITY_RESPONSE_INVALID'); }
  }
  return async (req, { fresh = false } = {}) => {
    if (typeof communityId !== 'string' || !/^[\p{L}\p{N}_-]{1,120}$/u.test(communityId)) fail(503, 'COMMUNITY_NOT_CONFIGURED');
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [^\s]{1,8192}$/.test(header)) fail(401, 'PROFILE_AUTH_REQUIRED');
    const token = header.slice(7), key = createHash('sha256').update(token).digest('hex');
    for (const [k, v] of cache) if (now() - v.at > 30000) cache.delete(k);
    if (!fresh && cache.has(key)) return cache.get(key).actor;
    if (now() - windowAt > 60000) { windowAt = now(); requests = 0; }
    if (inflight >= 8 || ++requests > 120 || cache.size >= 256 && !cache.has(key)) fail(503, 'IDENTITY_BUSY');
    inflight++;
    try {
      const profile = await json(PROFILE, token), id = String(profile?.id || profile?.clientId || profile?.uuid || '').trim();
      if (!id || id.length > 120 || /[\p{C}]/u.test(id)) fail(403, 'PROFILE_INVALID');
      const url = new URL(COMMUNITY_BASE + '/lk/communities/' + encodeURIComponent(communityId)); url.searchParams.set('clientId', id);
      const data = await json(url.href, token), community = data?.community ?? data?.data?.community ?? data?.data ?? data;
      if (!community || String(community.id) !== communityId || community.archived === true || community.membersLoaded === false || !Array.isArray(community.members)) fail(503, 'MEMBERSHIP_NOT_VERIFIED');
      const member = community.members.find(m => String(m.id ?? '') === id);
      if (!member || member.status && member.status !== 'ACTIVE' || (community.bannedMembers ?? []).some(m => String(m.id ?? '') === id)) fail(403, 'COMMUNITY_MEMBER_REQUIRED');
      const rawName = profile.name || profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || member.name;
      if (typeof rawName !== 'string' || !rawName.trim()) fail(503, 'PROFILE_NAME_MISSING');
      const actor = { id, communityId, name: rawName.replace(/[\p{C}<>]/gu, '').trim().slice(0, 48) };
      cache.set(key, { at: now(), actor }); return actor;
    } catch (error) { if (Number.isInteger(error.code)) throw error; fail(503, 'IDENTITY_UNAVAILABLE'); }
    finally { inflight--; }
  };
}
