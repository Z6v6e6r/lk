import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('new community enrollment collects only the requested private fields with explicit consent', async () => {
  const result = await build({ entryPoints: ['src/components/padel-jump/RaceAdmission.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl', '.webp': 'dataurl' }, logLevel: 'silent' });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  const html = renderToStaticMarkup(React.createElement(module.exports.EnrollmentForm, { busy: false, onSubmit() {} }));
  for (const name of ['firstName', 'lastName', 'email', 'companyWebsite']) assert.ok(html.includes(`name="${name}"`));
  assert.equal((html.match(/type="checkbox"/g) || []).length, 1);
  assert.match(html, /type="submit" disabled=""/);
  assert.ok(html.includes('Основной профиль ПадлхАБ не изменится') && !html.includes('name="actorId"'));
});

test('standalone SMS entry preserves consent gates while default LK OAuth remains available', async () => {
  const result = await build({ entryPoints: ['src/components/auth/VivaAuthForm.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl' }, logLevel: 'silent' });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  const Form = module.exports.VivaAuthForm, render = props => renderToStaticMarkup(React.createElement(Form, { onLogin() {}, ...props }));
  const standalone = render({ allowOAuth: false });
  assert.ok(!standalone.includes('VK ID') && !standalone.includes('>Yandex<'));
  assert.equal((standalone.match(/type="checkbox"/g) || []).length, 2);
  assert.match(standalone, /disabled=""[^>]*>.*?Войти по номеру/s);
  assert.ok(standalone.includes('https://padlhub.ru/docs') && standalone.includes('https://padlhub.ru/politica'));
  const yandexOnly = render({ oauthProviders: ['yandex'] }); assert.ok(yandexOnly.includes('Yandex') && !yandexOnly.includes('VK ID')); assert.equal((yandexOnly.match(/type="checkbox"/g) || []).length, 2);
  const normal = render({}); assert.ok(normal.includes('VK ID') && normal.includes('Yandex') && normal.includes('Еще варианты'));
  const restricted = render({ allowPhoneLogin: false }); assert.ok(!restricted.includes('Еще варианты') && !restricted.includes('Войти по номеру'));
});


test('existing profile never mounts as authenticated while a different OAuth callback is unresolved', async () => {
  const result = await build({ stdin: { contents: `import React from 'react'; import { VivaAuthProvider } from './src/context/VivaAuthProvider'; import { useAuth } from './src/context/authShared'; function State(){const a=useAuth();return React.createElement('output',null,JSON.stringify({authenticated:a.isAuthenticated,restoring:a.isRestoringSession,verification:a.needsPhoneVerification,phone:a.phone}));} export function Probe({mode='current-page'}={}){return React.createElement(VivaAuthProvider,{oauthCallbackMode:mode},React.createElement(State));}`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl' }, logLevel: 'silent' });
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const token = ['fixture', Buffer.from(JSON.stringify({phone_number:'fixture-phone',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'), 'fixture'].join('.');
  try {
    for(const pending of [true,false]){
      const url = new URL('https://padlhub.su/lk/padel-jump-team-86cdb47d/padel-jump-race.html?code=fixture-code&state=fixture-state');
      const storage = new Map(); if(pending)storage.set('padlhub_viva_oauth_pending_v1',JSON.stringify({provider:'yandex',state:'fixture-state',codeVerifier:'fixture-verifier',redirectUri:url.origin+url.pathname+'?authMode=viva',returnTo:url.origin+url.pathname}));
      Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:url.href,origin:url.origin,pathname:url.pathname,search:url.search,hash:''},localStorage:{getItem:()=>null},sessionStorage:{getItem:k=>storage.get(k)??null}}});
      Object.defineProperty(globalThis,'document',{configurable:true,value:{cookie:'padlhubAuthToken='+token}});
      const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,module,module.exports);
      const html=renderToStaticMarkup(React.createElement(module.exports.Probe));
      assert.ok(html.includes('&quot;authenticated&quot;:false') && html.includes('&quot;restoring&quot;:true'));
      assert.ok(html.includes('&quot;phone&quot;:&quot;&quot;'));
    }
    for(const stalePending of [false,true]){
      const url = new URL('https://padlhub.ru/community_join?code=legacy-community-code');
      const storage = new Map(); if(stalePending)storage.set('padlhub_viva_oauth_pending_v1',JSON.stringify({provider:'yandex',state:'old-fixture-state',codeVerifier:'fixture-verifier',redirectUri:url.origin+'/lk_new?authMode=viva',returnTo:url.origin+'/lk_new'}));
      Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:url.href,origin:url.origin,pathname:url.pathname,search:url.search,hash:''},localStorage:{getItem:()=>null},sessionStorage:{getItem:k=>storage.get(k)??null}}});
      const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,module,module.exports);
      const html=renderToStaticMarkup(React.createElement(module.exports.Probe,{mode:'cabinet'}));
      assert.ok(html.includes('&quot;authenticated&quot;:true') && html.includes('&quot;restoring&quot;:false'));
    }
  } finally {
    if(previousWindow===undefined)delete globalThis.window;else Object.defineProperty(globalThis,'window',{configurable:true,value:previousWindow});
    if(previousDocument===undefined)delete globalThis.document;else Object.defineProperty(globalThis,'document',{configurable:true,value:previousDocument});
  }
});
