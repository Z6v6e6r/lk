import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
const helpers = fs.readFileSync('src/utils/supportPhotos.ts', 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helperContext = { exports: {}, URL }; vm.runInNewContext(compile(helpers), helperContext);
const normalizeSupportPhotos = helperContext.exports.normalizeSupportPhotos;
test('photo normalizer accepts bounded raster/HTTPS and drops script, SVG, credentials and internal refs', () => {
  const input = ['https://synthetic.invalid/photo.jpg', 'data:image/jpeg;base64,/9j/2w==',
    'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', ['https://u:p', 'synthetic.invalid/a'].join('@'), 'cup-media:v1:private'];
  const normalized = normalizeSupportPhotos(input.map((url, i) => ({ id: `photo-${i}`, type: 'IMAGE', url })));
  assert.equal(normalized.length, 2);
  assert.equal(normalizeSupportPhotos(Array.from({ length: 11 }, () => ({ type: 'IMAGE', url: input[0] }))).length, 10);
});
test('photo-only/caption/text keep both actual API routes, attachments and zero POST replay', async () => {
  const start = source.indexOf('export async function apiCreateSupportDialogEvent');
  const end = source.indexOf('async function writePadelGameRecord', start);
  const body = compile(source.slice(start, end));
  for (const SUPPORT_API_BASE of ['', 'https://synthetic.invalid/api']) {
    for (const images of [0, 1, 10]) {
      const calls = [], context = { exports: {}, SUPPORT_API_BASE, normalizeSupportPhotos,
        normalizePhoneForChat: x => x, MESSAGE_DELIVERY_UNCONFIRMED: 'unconfirmed',
        requestSupportWithFallback: async (...args) => { calls.push(args); return { data: {}, status: 200 }; },
        extractSupportDialogEventResponse: x => x };
      vm.runInNewContext(body, context);
      await context.exports.apiCreateSupportDialogEvent({ phone: '70000000000', text: images === 1 ? '' : 'synthetic text',
        attachments: Array.from({ length: images }, (_, i) => ({ id: `photo-${i}`, type: 'IMAGE', url: 'data:image/jpeg;base64,/9j/2w==' })) });
      assert.equal(calls.length, 1); const [path, options] = calls[0], payload = JSON.parse(options.body);
      assert.equal(path, '/support/dialogs/events'); assert.equal(options.retries, 0);
      assert.equal(payload.attachments.length, images); assert.equal(payload.kind, images ? 'MEDIA' : 'TEXT');
      assert.equal(payload.text, images === 1 ? '' : 'synthetic text');
    }
  }
});
