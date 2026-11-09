import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { eventRegistrationCsv } from '../export_event_registrations.mjs';

const participantEmail = ['participant', 'example.invalid'].join('@');
const otherEmail = ['other', 'example.invalid'].join('@');
const policy = { version: 'event-registration-v1', responsibleName: 'Synthetic Organizer', contactEmail: ['organizer', 'example.invalid'].join('@'), startsAt: '2026-11-11T21:00:00.000Z', endsAt: '2026-11-13T21:00:00.000Z', retentionYears: 1 };
const epoch = '2026-11-09T09:00:00.000Z';
const document = () => ({ id: 'synthetic-exhibition', communityType: 'EVENT', typeSettingsRevision: 2, typeSettingsEffectiveAt: epoch, typeSettings: { gameIds: ['padel-jump'], registrationPolicy: structuredClone(policy) }, eventEntriesRevision: 1, eventEntries: [{ playerId: 'synthetic-participant', epoch, policyRevision: 2, policyVersion: policy.version, fullName: 'Synthetic Participant', company: '=HYPERLINK("https://example.invalid")', email: participantEmail, registeredAt: '2026-11-12T09:00:00.000Z', retentionUntil: '2027-11-13T21:00:00.000Z', run: { id: 'private-run' } }] });
function fixture(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'event-export-'));
  fs.chmodSync(root, 0o700);
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function exportSnapshot(root: string, doc = document(), extra: string[] = []) {
  const input = path.join(root, 'snapshot.json'), output = path.join(root, 'forms.csv');
  fs.writeFileSync(input, JSON.stringify(doc), { mode: 0o600 });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/export_event_registrations.mjs', '--input', input, '--out', output, '--community-id', doc.id, '--expected-sha', sha, '--now', '2026-11-14T09:00:00.000Z', ...extra], { encoding: 'utf8' });
  return { ...result, output, input };
}
test('organizer export writes only current private questionnaire fields to a new 0600 CSV and emits no PII', () => fixture(root => {
  const result = exportSnapshot(root);
  assert.equal(result.status, 0, result.stderr);
  const csv = fs.readFileSync(result.output, 'utf8');
  assert.match(csv, /Synthetic Participant/);
  assert.match(csv, /participant@example\.invalid/);
  assert.match(csv, /' =|"'=HYPERLINK/);
  assert.doesNotMatch(csv, /synthetic-participant|private-run|playerId|runId/);
  assert.equal(fs.statSync(result.output).mode & 0o777, 0o600);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.exportedCount, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /participant@example|Synthetic Participant|HYPERLINK|synthetic-exhibition/);
}));

test('a malformed activation epoch cannot silently turn a nonempty questionnaire set into an empty export', () => fixture(root => {
  const doc = document(); doc.typeSettingsEffectiveAt = 'unverified-epoch';
  const result = exportSnapshot(root, doc);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(result.output), false);
}));

test('current policy exports every current questionnaire once without stale epochs or result identifiers', () => {
  const doc = document();
  doc.eventEntries.push({ ...doc.eventEntries[0], playerId: 'synthetic-other', fullName: 'Other Participant', email: otherEmail });
  doc.eventEntries.push({ ...doc.eventEntries[0], playerId: 'synthetic-stale', epoch: '2026-11-08T09:00:00.000Z', fullName: 'Stale Participant' });
  const result = eventRegistrationCsv(doc, { communityId: doc.id, now: '2026-11-14T09:00:00.000Z' });
  assert.equal(result.receipt.exportedCount, 2);
  assert.match(result.csv, /Other Participant/);
  assert.doesNotMatch(result.csv, /Stale Participant|synthetic-other/);
  assert.equal(result.csv.split('\r\n').length, 4);
});

test('wrong target, missing policy, duplicate actors, malformed contacts and inconsistent retention fail closed', () => {
  for (const mutate of [
    (d: ReturnType<typeof document>) => { d.id = 'wrong-community'; },
    (d: ReturnType<typeof document>) => { d.communityType = 'FRIENDS'; },
    (d: ReturnType<typeof document>) => { d.typeSettings.registrationPolicy.contactEmail = ''; },
    (d: ReturnType<typeof document>) => { d.eventEntries.push({ ...d.eventEntries[0] }); },
    (d: ReturnType<typeof document>) => { d.eventEntries[0].email = 'bad'; },
    (d: ReturnType<typeof document>) => { d.eventEntries[0].fullName = 'Private\nPayload'; },
    (d: ReturnType<typeof document>) => { d.eventEntries[0].retentionUntil = '2099-01-01T00:00:00.000Z'; },
    (d: ReturnType<typeof document>) => { d.eventEntriesRevision = -1; },
  ]) {
    const doc = document(); mutate(doc);
    assert.throws(() => eventRegistrationCsv(doc, { communityId: 'synthetic-exhibition', now: '2026-11-14T09:00:00.000Z' }));
  }
});

test('retention expiry is inclusive and legitimate empty exports have an explicit zero count', () => {
  const doc = document();
  assert.equal(eventRegistrationCsv(doc, { communityId: doc.id, now: '2027-11-13T20:59:59.999Z' }).receipt.exportedCount, 1);
  assert.throws(() => eventRegistrationCsv(doc, { communityId: doc.id, now: '2027-11-13T21:00:00.000Z' }), /EVENT_EXPORT_DATA_EXPIRED/);
  doc.eventEntries = [];
  assert.equal(eventRegistrationCsv(doc, { communityId: doc.id, now: '2026-11-14T09:00:00.000Z' }).receipt.exportedCount, 0);
});

test('CLI rejects unpinned sources, public files, symlinks, existing outputs and unknown flags without printing inputs', () => {
  for (const condition of ['hash', 'mode', 'symlink', 'existing', 'unknown']) fixture(root => {
    const input = path.join(root, 'snapshot.json'), output = path.join(root, 'forms.csv');
    fs.writeFileSync(input, JSON.stringify(document()), { mode: 0o600 });
    const sha = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    if (condition === 'mode') fs.chmodSync(input, 0o644);
    if (condition === 'symlink') { fs.renameSync(input, path.join(root, 'original.json')); fs.symlinkSync(path.join(root, 'original.json'), input); }
    if (condition === 'existing') fs.writeFileSync(output, 'KEEP', { mode: 0o600 });
    const result = spawnSync(process.execPath, ['scripts/export_event_registrations.mjs', '--input', input, '--out', output, '--community-id', document().id, '--expected-sha', condition === 'hash' ? '0'.repeat(64) : sha, '--now', '2026-11-14T09:00:00.000Z', ...(condition === 'unknown' ? ['--secret', 'private-canary'] : [])], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /participant@example|private-canary|Synthetic Participant|snapshot\.json/);
    if (condition === 'existing') assert.equal(fs.readFileSync(output, 'utf8'), 'KEEP');
    else assert.equal(fs.existsSync(output), false);
  });
});
