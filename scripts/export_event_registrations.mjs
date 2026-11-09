/** Offline, operator-only questionnaire export. No DB, HTTP or public endpoint. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validatePrivatePreparationPaths } from './lib/privatePreparationPaths.mjs';
import { eventRegistration } from './lib/eventCommunity.mjs';
import { parseEventRegistrationPolicy, eventRetentionUntil } from '../src/services/community-policy.ts';

export function eventRegistrationCsv(document, { communityId, now }) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== now) throw new Error('EVENT_EXPORT_TIME_INVALID');
  if (!document || document.id !== communityId || typeof communityId !== 'string' || !/^[\p{L}\p{N}_-]{1,120}$/u.test(communityId) ||
      document.communityType !== 'EVENT' || !Number.isSafeInteger(document.typeSettingsRevision) || document.typeSettingsRevision < 1 ||
      !Number.isSafeInteger(document.eventEntriesRevision) || document.eventEntriesRevision < 0 ||
      typeof document.typeSettingsEffectiveAt !== 'string' || !Number.isFinite(Date.parse(document.typeSettingsEffectiveAt)) ||
      new Date(document.typeSettingsEffectiveAt).toISOString() !== document.typeSettingsEffectiveAt ||
      !Array.isArray(document.eventEntries) || document.eventEntries.length > 500) throw new Error('EVENT_EXPORT_SOURCE_INVALID');
  const policy = parseEventRegistrationPolicy(document.typeSettings?.registrationPolicy);
  const retentionUntil = eventRetentionUntil(policy.endsAt);
  if (now >= retentionUntil) throw new Error('EVENT_EXPORT_DATA_EXPIRED');
  const selected = document.eventEntries.filter(entry => entry?.epoch === document.typeSettingsEffectiveAt && entry.policyRevision === document.typeSettingsRevision && entry.policyVersion === policy.version);
  const actors = new Set();
  const rows = selected.map(entry => {
    if (typeof entry.playerId !== 'string' || !entry.playerId || actors.has(entry.playerId) || entry.retentionUntil !== retentionUntil ||
        typeof entry.registeredAt !== 'string' || !Number.isFinite(Date.parse(entry.registeredAt)) || new Date(entry.registeredAt).toISOString() !== entry.registeredAt) throw new Error('EVENT_EXPORT_ENTRY_INVALID');
    actors.add(entry.playerId);
    const data = eventRegistration({ fullName: entry.fullName, company: entry.company, email: entry.email });
    return [data.fullName, data.company, data.email, entry.registeredAt];
  });
  const cell = value => '"' + (/^\s*[=+@-]/u.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
  const csv = '\ufeff' + [['ФИО', 'Компания', 'Email', 'Дата регистрации (UTC)'], ...rows].map(row => row.map(cell).join(';')).join('\r\n') + '\r\n';
  return { csv, receipt: { operationId: randomUUID(), preparedAt: now, exportedCount: rows.length, policyRevision: document.typeSettingsRevision, entriesRevision: document.eventEntriesRevision } };
}

export function exportEventRegistrations({ input, output, communityId, expectedSha, now }) {
  validatePrivatePreparationPaths(input, output);
  const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 8 * 1024 * 1024) throw new Error('EVENT_EXPORT_SOURCE_INVALID');
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  if (!/^[a-f0-9]{64}$/.test(expectedSha || '') || createHash('sha256').update(bytes).digest('hex') !== expectedSha) throw new Error('EVENT_EXPORT_SHA_MISMATCH');
  const result = eventRegistrationCsv(JSON.parse(bytes.toString('utf8')), { communityId, now });
  const target = fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(target, result.csv); fs.fsyncSync(target); } finally { fs.closeSync(target); }
  const parent = fs.openSync(path.dirname(output), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  return result.receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values, tokens } = parseArgs({ options: Object.fromEntries(['input', 'out', 'community-id', 'expected-sha', 'now'].map(key => [key, { type: 'string' }])), tokens: true });
    if (Object.keys(values).length !== 5 || tokens.length !== 5) throw new Error('EVENT_EXPORT_ARGUMENTS_INVALID');
    const receipt = exportEventRegistrations({ input: values.input, output: values.out, communityId: values['community-id'], expectedSha: values['expected-sha'], now: values.now });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const code = /^(?:EVENT_(?:EXPORT|REGISTRATION|POLICY)_[A-Z_]+|PREPARATION_[A-Z_]+)$/.test(error.message) ? error.message : 'EVENT_EXPORT_FAILED';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }
}
