import fs from 'node:fs';
import crypto from 'node:crypto';
import { createLk1VivaServiceToken } from './lk1VivaServiceToken.mjs';
import { createVivaFetch } from './vivaUserAgent.mjs';

const NUMERIC_FIELD = 'eabfe27b-3f72-4496-9185-1a2ec6e6465e';
const GRADE_FIELD = 'f9790818-25fd-4b73-a781-79c02720727d';
const fail = (code, playerId) => { const error = Error(code); error.playerId = playerId; throw error; };
const empty = value => value === null || value === undefined || typeof value === 'string' && value.trim() === '';
const fieldValue = (fields, id, playerId) => {
  const matches = fields.filter(field => field?.id === id);
  if (matches.length > 1) fail('FPR_START_INVALID_LEVEL', playerId);
  if (!matches.length) return null;
  const values = matches[0].value;
  if (values === null || values === undefined) return null;
  if (!Array.isArray(values) || values.length > 1) fail('FPR_START_INVALID_LEVEL', playerId);
  const value = values[0];
  if (!empty(value) && typeof value !== 'string' && typeof value !== 'number') fail('FPR_START_INVALID_LEVEL', playerId);
  return value;
};

/** A successful exact-client profile is required even when both level fields are empty. */
export function parseFprVivaStartLevel(profile, clientId, fetchedAt = new Date().toISOString()) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.id !== clientId
    || !Array.isArray(profile.customFields)
    || profile.customFields.some(field => !field || typeof field !== 'object' || Array.isArray(field) || typeof field.id !== 'string' || !field.id)
    || !Number.isFinite(Date.parse(fetchedAt))) fail('FPR_START_VIVA_UNAVAILABLE', clientId);
  const rawNumeric = fieldValue(profile.customFields, NUMERIC_FIELD, clientId);
  const rawGrade = fieldValue(profile.customFields, GRADE_FIELD, clientId);
  let ratingNumeric, source;
  if (empty(rawNumeric)) {
    if (!empty(rawGrade)) fail('FPR_START_INVALID_LEVEL', clientId);
    ratingNumeric = 1; source = 'VERIFIED_VIVA_UNRATED_DEFAULT_1';
  } else {
    // Zero, a grade alone, non-decimal text and malformed fields are not evidence of being unrated.
    if (typeof rawNumeric === 'string' && !/^\d+(?:[.,]\d+)?$/.test(rawNumeric.trim())) fail('FPR_START_INVALID_LEVEL', clientId);
    ratingNumeric = Number(String(rawNumeric).trim().replace(',', '.'));
    if (!Number.isFinite(ratingNumeric) || ratingNumeric < 1 || ratingNumeric > 7) fail('FPR_START_INVALID_LEVEL', clientId);
    source = 'VIVA_NUMERIC';
  }
  const minimal = { clientId, rawNumeric: rawNumeric ?? null, rawGrade: rawGrade ?? null };
  return Object.freeze({ clientId, ratingNumeric, source, fetchedAt,
    evidenceSha256: crypto.createHash('sha256').update(JSON.stringify(minimal)).digest('hex') });
}

/** Existing root-only attendance configuration; no credential changes or browser input. */
export function readFprVivaServiceConfig() {
  const file = '/etc/padlhub-rating-worker.env';
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) || stat.nlink !== 1) throw Error('FPR_START_VIVA_UNAVAILABLE');
    const values = Object.fromEntries(fs.readFileSync(fd, 'utf8').split('\n').flatMap(line => {
      const text = line.trim(); if (!text || text.startsWith('#')) return [];
      const at = text.indexOf('='); if (at <= 0) return [];
      let value = text.slice(at + 1).trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      return [[text.slice(0, at), value]];
    }));
    return { tokenUrl: 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token',
      clientId: values.VIVA_CLIENT_ID, username: values.VIVA_USERNAME, password: values.VIVA_PASSWORD };
  } finally { fs.closeSync(fd); }
}

export function createFprVivaStartReader({ readConfig = readFprVivaServiceConfig, fetchImpl = fetch,
  now = () => new Date().toISOString(), budgetMs = 9000 } = {}) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 10000) throw Error('FPR_START_ARGUMENTS');
  return async clientIds => {
    const deadline = AbortSignal.timeout(budgetMs);
    const vivaFetch = createVivaFetch((url, options) => fetchImpl(url, { ...options,
      signal: AbortSignal.any([deadline, options.signal].filter(Boolean)) }));
    const token = createLk1VivaServiceToken({ readConfig, fetchImpl: vivaFetch, timeoutMs: budgetMs });
    let bearer;
    try { bearer = await token(); } catch { fail('FPR_START_VIVA_UNAVAILABLE', clientIds[0]); }
    const results = new Map(); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(6, clientIds.length) }, async () => {
      while (cursor < clientIds.length) {
        const clientId = clientIds[cursor++];
        try {
          const response = await vivaFetch('https://api.vivacrm.ru/api/v1/clients/' + encodeURIComponent(clientId),
            { method: 'GET', redirect: 'error', signal: deadline,
              headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json' } });
          if (response.status !== 200) fail('FPR_START_VIVA_UNAVAILABLE', clientId);
          const parsed = parseFprVivaStartLevel(await response.json(), clientId, now());
          results.set(clientId, parsed);
        } catch (error) {
          if (/^FPR_START_(INVALID_LEVEL|VIVA_UNAVAILABLE)$/.test(error.message)) throw error;
          fail('FPR_START_VIVA_UNAVAILABLE', clientId);
        }
      }
    }));
    return results;
  };
}
