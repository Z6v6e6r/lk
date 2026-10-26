import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { COMMUNITY_BASE, identityJson } from './identity.mjs';
import { fail } from './registry.mjs';
import { normalizeEnrollment } from '../../../src/components/padel-jump/enrollment-form.ts';

const consentVersion = 'jump-community-v1';
function privateStore(directory, communityId) {
  const root = directory ? join(directory, 'enrollments') : null;
  const key = id => createHash('sha256').update(communityId + '\0' + id).digest('hex') + '.json';
  const check = () => { if (!root) fail(503, 'ENROLLMENT_STORAGE_UNAVAILABLE'); mkdirSync(root, { recursive: true, mode: 0o700 }); const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail(503, 'ENROLLMENT_STORAGE_UNAVAILABLE'); };
  const read = id => {
    if (!root) return null;
    let rootStat; try { rootStat = lstatSync(root); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077)) fail(503, 'ENROLLMENT_STORAGE_UNAVAILABLE');
    const file = join(root, key(id));
    let stat; try { stat = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (stat.mode & 0o077)) fail(503, 'ENROLLMENT_STORAGE_UNAVAILABLE');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.schema !== 1 || record.profileId !== id || record.communityId !== communityId || record.consentVersion !== consentVersion || !['saved', 'joining', 'unconfirmed', 'complete'].includes(record.phase)) fail(503, 'ENROLLMENT_STORAGE_UNAVAILABLE');
    normalizeEnrollment({ ...record.data, consent: true });
    return record;
  };
  const write = record => {
    check();
    if (!read(record.profileId) && readdirSync(root).filter(v => /^[a-f0-9]{64}\.json$/.test(v)).length >= 500) fail(409, 'ENROLLMENT_LIMIT');
    const temporary = join(root, '.pending-' + randomUUID()), target = join(root, key(record.profileId));
    let fd;
    try { fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, target); const dir = openSync(root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* Preserve the original failure; unpublished private temp files are ignored. */ } }
  };
  return { read, write };
}

/** Verified own-profile admission. Private forms never enter run or board state. */
export function createEnrollment({ authenticate, communityId, directory, fetcher = fetch, now = () => Date.now() }) {
  const store = privateStore(directory, communityId);
  let tail = Promise.resolve(), queued = 0;
  const inspect = req => {
    if (typeof authenticate.inspect !== 'function') fail(503, 'ENROLLMENT_UNAVAILABLE');
    return authenticate.inspect(req, { fresh: true });
  };
  const result = identity => {
    const record = store.read(identity.id);
    const state = identity.membership === 'ACTIVE' ? 'ready' : identity.membership === 'BANNED' ? 'blocked' : identity.membership === 'PENDING' ? 'pending' : record && ['joining', 'unconfirmed'].includes(record.phase) ? 'confirming' : 'form';
    const source = record?.data ?? identity.profile;
    return { state, name: identity.actor?.name ?? '', communityName: typeof identity.community.name === 'string' ? identity.community.name : 'ПадлхАБ команда',
      ...(state === 'form' ? { fields: Object.fromEntries(['firstName', 'lastName', 'email', 'companyWebsite'].map(k => [k, typeof source?.[k] === 'string' ? source[k].slice(0, 500) : ''])) } : {}) };
  };
  return {
    status: async req => result(await inspect(req)),
    submit: (req, body) => {
      let data; try { data = normalizeEnrollment(body); } catch { fail(422, 'ENROLLMENT_INVALID'); }
      if (queued >= 12) fail(503, 'ENROLLMENT_BUSY');
      queued++; const requestedAt = now();
      // The existing generic roster writer is snapshot based: serialize all
      // joins from this service, not just retries from the same participant.
      const task = tail.then(async () => {
        if (now() - requestedAt > 20000) fail(503, 'ENROLLMENT_BUSY');
        const identity = await inspect(req);
        if (identity.membership !== 'NONE') return result(identity);
        const previous = store.read(identity.id);
        if (previous && ['joining', 'unconfirmed'].includes(previous.phase)) return result(identity);
        const inviteCode = identity.community.inviteCode;
        if (typeof inviteCode !== 'string' || !/^[\p{L}\p{N}_-]{1,160}$/u.test(inviteCode)) fail(503, 'COMMUNITY_INVITE_UNAVAILABLE');
        const record = { schema: 1, profileId: identity.id, communityId, consentVersion, data, phase: 'saved', createdAt: previous?.createdAt ?? new Date(now()).toISOString() };
        store.write(record); // A failed private write must prevent the join.
        record.phase = 'joining'; store.write(record);
        try {
          await identityJson(fetcher, COMMUNITY_BASE + '/lk/communities/join-by-invite', req.headers.authorization.slice(7), { method: 'POST', timeoutMs: 8000, body: JSON.stringify({ inviteCode, member: { id: identity.id, name: identity.actor?.name || (data.firstName + ' ' + data.lastName).slice(0, 48), role: 'MEMBER' } }) });
        } catch { /* Outcome is resolved by a fresh membership read, never by 200 alone. */ }
        let confirmed;
        try { confirmed = await inspect(req); } catch { record.phase = 'unconfirmed'; store.write(record); fail(503, 'ENROLLMENT_JOIN_UNCONFIRMED'); }
        record.phase = confirmed.membership === 'ACTIVE' ? 'complete' : 'unconfirmed'; store.write(record);
        return result(confirmed);
      });
      tail = task.catch(() => {});
      return task.finally(() => { queued--; });
    },
  };
}
