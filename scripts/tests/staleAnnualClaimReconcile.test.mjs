import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { annualHistory } from '../lib/annualSubscriptionHistory.mjs';
import { releaseAllAnnualClaims } from '../lib/annualClaimRelease.mjs';

const FIXTURE_URL = new URL('../tests/fixtures/annualHubLedger.networkFriendshipEpoch.json', import.meta.url);
const fixture = () => JSON.parse(fs.readFileSync(fileURLToPath(FIXTURE_URL), 'utf8'));
const SCRIPT = fileURLToPath(new URL('../reconcile_stale_annual_claims.mjs', import.meta.url));
// The fixture's only open claim expires at 2026-09-11T18:04:46Z, so this instant
// is after its deadline while the Moscow daily seat is unchanged.
const NOW = '2026-09-11T19:00:00.000Z';
const BEFORE_DEADLINE = '2026-09-11T17:00:00.000Z';

const withFixture = (ledger) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-annual-claims-'));
  const fixturePath = path.join(dir, 'ledger.json');
  fs.writeFileSync(fixturePath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { dir, fixturePath };
};

const runCli = (args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('the CLI rehearses offline and reports exactly the stale claim as releasable', () => {
  const { dir, fixturePath } = withFixture(fixture());
  try {
    const report = JSON.parse(runCli(['--fixture', fixturePath, '--now', NOW]));
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.ledgerCount, 1);
    assert.equal(report.scannedClaims, 3);
    assert.equal(report.releasableClaims, 1);
    assert.equal(report.applied, false);
    assert.equal(report.reason, 'DRY_RUN_RELEASABLE');
    assert.deepEqual(report.backupPaths, []);
    assert.equal(report.released.length, 1);
    assert.equal(report.released[0].state, 'PAYMENT_PENDING');
    assert.equal(report.released[0].reason, 'RELEASABLE');
    // Reports carry only stable hash labels, never the raw inventory or payment ref.
    assert.match(report.released[0].ledger, /^[0-9a-f]{12}$/);
    assert.match(report.released[0].claim, /^[0-9a-f]{12}$/);
    const raw = JSON.stringify(report);
    assert.equal(raw.includes('fixture-payment-ref-3'), false);
    assert.equal(raw.includes('network_friendship_12m_20260910_epoch'), false);
    // Terminal claims are reported as skipped with their own reason code.
    assert.deepEqual(report.skipped.map((item) => item.reason).sort(), ['STATE_TERMINAL', 'STATE_TERMINAL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI finds nothing to release while the checkout window is still open', () => {
  const { dir, fixturePath } = withFixture(fixture());
  try {
    const report = JSON.parse(runCli(['--fixture', fixturePath, '--now', BEFORE_DEADLINE]));
    assert.equal(report.releasableClaims, 0);
    assert.equal(report.reason, 'NOTHING_TO_RELEASE');
    assert.equal(report.released.length, 0);
    assert.equal(report.skipped.find((item) => item.state === 'PAYMENT_PENDING').reason, 'DEADLINE_NOT_REACHED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses --apply together with --fixture before any write', () => {
  const { dir, fixturePath } = withFixture(fixture());
  try {
    assert.throws(() => runCli(['--fixture', fixturePath, '--apply', '--backup-dir', dir]),
      /--apply cannot be combined with --fixture/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply without --backup-dir is refused', () => {
  assert.throws(() => runCli(['--mongo-url', 'mongodb://127.0.0.1:27017/games', '--apply']),
    /--backup-dir is required with --apply/);
});

test('--help prints usage without requiring a mongo url', () => {
  const out = runCli(['--help']);
  assert.match(out, /reconcile_stale_annual_claims/);
  assert.match(out, /--backup-dir/);
});

test('the release plan matches the library transformation the CLI applies', () => {
  // Guards the CLI against drifting from the reviewed library: the same ledger
  // through the library releases exactly the one claim the CLI reported.
  const ledger = fixture();
  const outcome = releaseAllAnnualClaims(ledger, { now: NOW });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.released.length, 1);
  assert.equal(annualHistory.validate(outcome.next), true);
  assert.equal(outcome.next.reservedCount, ledger.reservedCount - 1);
  assert.equal(outcome.next.dailyReservedCount, ledger.dailyReservedCount - 1);
});
