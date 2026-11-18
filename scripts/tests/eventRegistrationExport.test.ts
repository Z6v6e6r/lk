import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { eventRegistrationCsv, exportEventRegistrations } from '../export_event_registrations.mjs';

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
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/export_event_registrations.mjs', '--input', input, '--out', output, '--community-id', doc.id, '--expected-sha', sha, ...extra], { encoding: 'utf8' });
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
  doc.eventEntries.push({ ...doc.eventEntries[0], playerId: 'synthetic-stale-policy', policyRevision: 1, fullName: 'Stale Policy' });
  doc.eventEntries.push({ ...doc.eventEntries[0], playerId: 'synthetic-stale-version', policyVersion: 'event-registration-v0', fullName: 'Stale Version' });
  const result = eventRegistrationCsv(doc, { communityId: doc.id, now: '2026-11-14T09:00:00.000Z' });
  assert.equal(result.receipt.exportedCount, 2);
  assert.match(result.csv, /Other Participant/);
  assert.doesNotMatch(result.csv, /Stale Participant|Stale Policy|Stale Version|synthetic-other/);
  assert.equal(result.csv.split('\r\n').length, 4);
});

test('perpetual exhibition exports only unexpired submissions even after the game retention cutoff',()=>{
  const doc=document();doc.id='community_1794221739126_корпспорт-падлхаб-2026';
  Object.assign(doc.eventEntries[0],{retentionMode:'submitted-year-v1',retentionUntil:'2027-11-12T09:00:00.000Z'});
  doc.eventEntries.push({...doc.eventEntries[0],playerId:'synthetic-new',fullName:'Fresh Participant',email:otherEmail,registeredAt:'2027-11-14T09:00:00.000Z',retentionUntil:'2028-11-14T09:00:00.000Z'});
  const result=eventRegistrationCsv(doc,{communityId:doc.id,now:'2027-11-14T10:00:00.000Z'});
  assert.equal(result.receipt.exportedCount,1);assert.match(result.csv,/Fresh Participant/);
  assert.doesNotMatch(result.csv,/Synthetic Participant|participant@example/);
  assert.equal(eventRegistrationCsv(doc,{communityId:doc.id,now:'2028-11-14T09:00:00.000Z'}).receipt.exportedCount,0);
  doc.eventEntries[1].retentionUntil='2099-01-01T00:00:00.000Z';
  assert.throws(()=>eventRegistrationCsv(doc,{communityId:doc.id,now:'2027-11-14T10:00:00.000Z'}),/EVENT_EXPORT_ENTRY_INVALID/);
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

test('file-producing export uses execution time: a stale supplied timestamp cannot bypass the inclusive deadline', t => fixture(root => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-11-13T21:00:00.000Z') });
  const input = path.join(root, 'snapshot.json'), output = path.join(root, 'forms.csv'), doc = document();
  fs.writeFileSync(input, JSON.stringify(doc), { mode: 0o600 });
  const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  assert.throws(() => exportEventRegistrations({ input, output, communityId: doc.id, expectedSha, ...{ now: '2026-11-14T09:00:00.000Z' } }), /EVENT_EXPORT_DATA_EXPIRED/);
  assert.equal(fs.existsSync(output), false);
}));

test('a successful file export records fresh execution time rather than a supplied historical receipt time', t => fixture(root => {
  const executionTime = '2027-11-13T20:59:59.999Z';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(executionTime) });
  const input = path.join(root, 'snapshot.json'), output = path.join(root, 'forms.csv'), doc = document();
  fs.writeFileSync(input, JSON.stringify(doc), { mode: 0o600 });
  const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  const receipt = exportEventRegistrations({ input, output, communityId: doc.id, expectedSha, ...{ now: '2026-11-14T09:00:00.000Z' } });
  assert.equal(receipt.preparedAt, executionTime);
  assert.equal(receipt.exportedCount, 1);
}));

test('CSV has an exact BOM/header/delimiter/quote contract and neutralizes every spreadsheet formula prefix', () => {
  for (const company of ['=SUM(1;2)', '+123', '-123', '@name', '  =SUM(1;2)']) {
    const doc = document(); doc.eventEntries[0].company = company;
    const { csv } = eventRegistrationCsv(doc, { communityId: doc.id, now: '2026-11-14T09:00:00.000Z' });
    assert.equal(csv, '\ufeff"ФИО";"Компания";"Email";"Дата регистрации (UTC)"\r\n"Synthetic Participant";"\'' + company.trim() + '";"' + participantEmail + '";"2026-11-12T09:00:00.000Z"\r\n');
  }
  const doc = document(); doc.eventEntries[0].company = 'Company; "Quoted"';
  assert.ok(eventRegistrationCsv(doc, { communityId: doc.id, now: '2026-11-14T09:00:00.000Z' }).csv.includes('"Company; ""Quoted""";'));
});

test('CLI rejects unpinned sources, public files, symlinks, existing outputs and unknown flags without printing inputs', () => {
  for (const condition of ['hash', 'mode', 'symlink', 'existing', 'unknown', 'historical']) fixture(root => {
    const input = path.join(root, 'snapshot.json'), output = path.join(root, 'forms.csv');
    fs.writeFileSync(input, JSON.stringify(document()), { mode: 0o600 });
    const sha = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    if (condition === 'mode') fs.chmodSync(input, 0o644);
    if (condition === 'symlink') { fs.renameSync(input, path.join(root, 'original.json')); fs.symlinkSync(path.join(root, 'original.json'), input); }
    if (condition === 'existing') fs.writeFileSync(output, 'KEEP', { mode: 0o600 });
    const result = spawnSync(process.execPath, ['scripts/export_event_registrations.mjs', '--input', input, '--out', output, '--community-id', document().id, '--expected-sha', condition === 'hash' ? '0'.repeat(64) : sha, ...(condition === 'unknown' ? ['--secret', 'private-canary'] : condition === 'historical' ? ['--now', '2026-11-14T09:00:00.000Z'] : [])], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /participant@example|private-canary|Synthetic Participant|snapshot\.json/);
    if (condition === 'existing') assert.equal(fs.readFileSync(output, 'utf8'), 'KEEP');
    else assert.equal(fs.existsSync(output), false);
  });
});
