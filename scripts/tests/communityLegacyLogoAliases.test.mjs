import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
const prefix = 'const commonHelpers = String.raw`';
const start = source.indexOf(prefix) + prefix.length;
const end = source.indexOf('\n`;\n', start);
const helpers = new Function(`return String.raw\`${source.slice(start, end + 1)}\`;`)();
const resolve = new Function(`${helpers};return resolveCommunityLogoFields;`)();
const legacy = '/lk/media/community-logo-legacy/fixture';
const data = 'data:image/png;base64,aGVsbG8=';

test('community metadata does not advertise a self legacy alias with no backing data', () => {
  const result = resolve({ id: 'fixture', logo: legacy, logoUrl: legacy, logoThumbUrl: legacy + '/thumb' });
  assert.deepEqual(result, { logo: null, logoUrl: null, logoThumbUrl: null });
  const valid = resolve({ id: 'fixture', logoUrl: legacy, logoThumbUrl: legacy + '/thumb', logoLegacyDataUrl: data });
  assert.equal(valid.logoUrl, legacy);
  assert.equal(valid.logoThumbUrl, legacy + '/thumb');
});

test('modern assets and unverified foreign URLs remain intact', () => {
  const modern = '/lk/media/community-logo/fixture-asset';
  const result = resolve({ id: 'fixture', logoUrl: modern, logoThumbUrl: legacy + '/thumb' });
  assert.equal(result.logoUrl, modern);
  assert.equal(result.logoThumbUrl, modern);
  const foreign = 'https://images.example.test' + legacy;
  assert.equal(resolve({ id: 'fixture', logoUrl: foreign }).logoUrl, foreign);
  const other = '/lk/media/community-logo-legacy/other-community';
  assert.equal(resolve({ id: 'fixture', logoUrl: other }).logoUrl, other);
});

test('malformed legacy data cannot republish a rejected self alias', () => {
  for (const value of ['data:bad', 'data:image/png,%ZZ']) {
    const result = resolve({ id: 'fixture', logoUrl: legacy, logoThumbUrl: legacy + '/thumb', logoLegacyDataUrl: value });
    assert.deepEqual(result, { logo: null, logoUrl: null, logoThumbUrl: null });
  }
});


test('self aliases are checked across proxy protocol and trusted public host differences', () => {
  for (const url of [
    'https://example.test' + legacy,
    'https://EXAMPLE.test:443' + legacy,
    'https://padlhub.ru' + legacy,
    '//padlhub.su' + legacy,
  ]) {
    assert.equal(resolve({ id: 'fixture', logoUrl: url }, { publicBaseUrl: 'http://example.test' }).logoUrl, null);
    assert.equal(resolve({ id: 'fixture', logoUrl: url, logoDataUrl: data }, { publicBaseUrl: 'http://example.test' }).logoUrl, url.startsWith('//') ? 'http:' + url : url);
  }
});

test('lookalike, credential-bearing and nonstandard-port foreign assets are preserved', () => {
  for (const host of ['padlhub.ru.evil.test', 'padlhub.ru' + '@' + 'evil.test', 'padlhub.ru:8443', 'padlhub.ru:80', 'images.example.test']) {
    const url = 'https://' + host + legacy;
    assert.equal(resolve({ id: 'fixture', logoUrl: url }, { publicBaseUrl: 'http://padlhub.ru' }).logoUrl, url);
  }
});

test('configured LK fallback self aliases require the original or thumb backing data', () => {
  const origin = 'https://lk-reserve.89-108-64-209.sslip.io';
  const row = { id: 'fixture', logo: origin + legacy + '/thumb', logoUrl: origin + legacy, logoThumbUrl: origin + legacy + '/thumb' };
  assert.deepEqual(resolve(row, { publicBaseUrl: 'https://padlhub.su' }), { logo: null, logoUrl: null, logoThumbUrl: null });
  for (const backing of ['logoLegacyDataUrl', 'logoDataUrl']) {
    assert.equal(resolve({ ...row, [backing]: data }).logoUrl, row.logoUrl);
  }
  assert.equal(resolve({ ...row, logoThumbDataUrl: data }).logoThumbUrl, row.logoThumbUrl);
  assert.equal(resolve({ ...row, logoLegacyDataUrl: 'data:bad' }).logo, null);
});

test('fallback lookalikes, other records and modern external assets stay unchanged', () => {
  for (const authority of ['lk-reserve.89-108-64-209.sslip.io.evil.test', 'lk-reserve.89-108-64-209.sslip.io:8443', 'lk-reserve.89-108-64-209.sslip.io@evil.test']) {
    const url = 'https://' + authority + legacy;
    assert.equal(resolve({ id: 'fixture', logoUrl: url }).logoUrl, url);
  }
  const origin = 'https://lk-reserve.89-108-64-209.sslip.io';
  for (const path of ['/lk/media/community-logo-legacy/other', '/lk/media/community-logo/asset']) {
    assert.equal(resolve({ id: 'fixture', logoUrl: origin + path }).logoUrl, origin + path);
  }
});
