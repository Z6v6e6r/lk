import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

async function loadComponent(path, name) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) },
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports[name];
}

const Card = await loadComponent('src/components/atlanty-schedule/AtlantySchedulePage.tsx', 'AtlantyCard');
const Modal = await loadComponent('src/components/atlanty-schedule/AtlantyEventModal.tsx', 'AtlantyEventModalContent');
const event = {
  id: 'patriots-game-1',
  title: 'Игра Патриотов',
  dayLabel: '30',
  weekdayLabel: 'Ср',
  dateTimeLabel: '30 сентября, 19:00',
};

test('disabled booking keeps event details but exposes no Viva booking link', () => {
  const card = renderToStaticMarkup(React.createElement(Card, {
    event,
    pillLabel: 'Патриоты',
    options: { pillIcon: 'none', avatarMode: 'none', seatsStyle: 'plain', levelStyle: 'meta' },
    onOpen() {},
    showVivaAnchor: false,
  }));
  assert.match(card, /<button[^>]*class="atlanty-card"/);
  assert.doesNotMatch(card, /data-atlanty-exercise|href=/);

  const modal = renderToStaticMarkup(React.createElement(Modal, {
    event,
    imageUrl: null,
    pillLabel: 'Патриоты',
    vivaInstance: 'viva',
    onClose() {},
    bookingMode: 'disabled',
  }));
  assert.match(modal, /<button[^>]*disabled=""[^>]*>Запись подключается<\/button>/);
  assert.doesNotMatch(modal, /Записаться|href=/);
  assert.match(modal, />Закрыть<\/button>/);
});
