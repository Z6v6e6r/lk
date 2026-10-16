import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRepositoryProvenance } from '../lib/release-provenance.mjs';
import { writeStorefrontRelease } from '../write-storefront-release.mjs';

test('storefront manifest binds each channel to exact bytes and keeps real Git provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'storefront-release-'));
  try {
    const provenance = readRepositoryProvenance(process.cwd());
    for (const channel of ['prod', 'dev']) {
      const suffix = channel === 'dev' ? '-dev' : '';
      const fileName = `subscription-storefront${suffix}.js`;
      const bytes = Buffer.from(`window.LKWidgetSubscriptionStorefront={checkoutVersion:1,checkoutIsolationVersion:1,checkoutChannel:"${channel}"}; // ${channel}`);
      await writeFile(join(directory, fileName), bytes);
      const { targetFile, payload } = await writeStorefrontRelease(directory, channel, { now: new Date('2026-10-16T12:34:56Z'), version: 'fixture-v1' });
      assert.equal(targetFile, join(directory, `release${suffix}.json`));
      assert.deepEqual(JSON.parse(await readFile(targetFile, 'utf8')), payload);
      assert.equal(payload.version, 'fixture-v1');
      assert.equal(payload.generatedAt, '2026-10-16T12:34:56.000Z');
      for (const key of ['sourceCommit', 'sourceBranch', 'sourceDirty']) assert.equal(payload[key], provenance[key]);
      assert.equal(payload.checkoutVersion, 1); assert.equal(payload.checkoutIsolationVersion, 1); assert.equal(payload.checkoutChannel, channel);
      assert.deepEqual(payload.script, { fileName, integrity: 'sha384-' + createHash('sha384').update(bytes).digest('base64') });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('manifest writer rejects absent, old or wrong-channel artifacts without replacing a manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'storefront-release-'));
  try {
    const target = join(directory, 'release.json');
    await writeFile(target, 'previous manifest');
    await assert.rejects(writeStorefrontRelease(directory, 'prod'), /ENOENT/);
    for (const contract of ['checkoutVersion:1,checkoutChannel:"prod"', 'checkoutVersion:2,checkoutIsolationVersion:1,checkoutChannel:"prod"', 'checkoutVersion:1,checkoutIsolationVersion:1,checkoutChannel:"dev"']) {
      await writeFile(join(directory, 'subscription-storefront.js'), `window.LKWidgetSubscriptionStorefront={${contract}};`);
      await assert.rejects(writeStorefrontRelease(directory, 'prod'), /isolated checkout contract/);
      assert.equal(await readFile(target, 'utf8'), 'previous manifest');
    }
    await assert.rejects(writeStorefrontRelease(directory, '../prod'), /channel/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
