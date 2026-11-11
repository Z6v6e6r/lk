import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedPreviewConfig, writeHostedPreview } from './hostedPreview.ts';

test('hosting accepts only an isolated versioned static path with source provenance', () => {
  const source = 'a'.repeat(40);
  assert.deepEqual(hostedPreviewConfig({}), { base: '/', source: null });
  assert.deepEqual(hostedPreviewConfig({ BOOKING_PREVIEW_BASE: '/lk/booking-preview/v1/', BOOKING_PREVIEW_SOURCE_SHA: source }), { base: '/lk/booking-preview/v1/', source });
  for (const base of ['/lk/', '/lk/booking-preview/../', '//example.com/', '/lk/booking-preview/v1/?x=1']) {
    assert.throws(() => hostedPreviewConfig({ BOOKING_PREVIEW_BASE: base, BOOKING_PREVIEW_SOURCE_SHA: source }));
  }
  assert.throws(() => hostedPreviewConfig({ BOOKING_PREVIEW_BASE: '/lk/booking-preview/v1/' }));
});

test('hosted output has a root entry and a file hash manifest for exact public readback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'booking-preview-hosting-'));
  try {
    await mkdir(join(directory, 'dev/booking-preview'), { recursive: true });
    await writeFile(join(directory, 'dev/booking-preview/index.html'), '<!doctype html><title>Test preview</title>');
    const config = hostedPreviewConfig({ BOOKING_PREVIEW_BASE: '/lk/booking-preview/v1/', BOOKING_PREVIEW_SOURCE_SHA: 'a'.repeat(40) });
    await writeHostedPreview(directory, config);
    const manifest = JSON.parse(await readFile(join(directory, 'preview-release.json'), 'utf8'));
    assert.equal(manifest.source, config.source);
    assert.equal(manifest.mockOnly, true);
    assert.deepEqual(manifest.stages, ['current', 'full']);
    assert.equal(manifest.files['index.html'], manifest.files['dev/booking-preview/index.html']);
    assert.match(manifest.files['index.html'], /^[a-f0-9]{64}$/);
    assert.ok(!manifest.files['preview-release.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
