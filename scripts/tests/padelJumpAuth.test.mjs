import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('standalone SMS entry preserves consent gates while default LK OAuth remains available', async () => {
  const result = await build({ entryPoints: ['src/components/auth/VivaAuthForm.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl' }, logLevel: 'silent' });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  const Form = module.exports.VivaAuthForm, render = props => renderToStaticMarkup(React.createElement(Form, { onLogin() {}, ...props }));
  const standalone = render({ allowOAuth: false });
  assert.ok(!standalone.includes('VK ID') && !standalone.includes('>Yandex<'));
  assert.equal((standalone.match(/type="checkbox"/g) || []).length, 2);
  assert.match(standalone, /disabled=""[^>]*>.*?Войти по номеру/s);
  assert.ok(standalone.includes('https://padlhub.ru/docs') && standalone.includes('https://padlhub.ru/politica'));
  const normal = render({}); assert.ok(normal.includes('VK ID') && normal.includes('Yandex') && normal.includes('Еще варианты'));
  const restricted = render({ allowPhoneLogin: false }); assert.ok(!restricted.includes('Еще варианты') && !restricted.includes('Войти по номеру'));
});
