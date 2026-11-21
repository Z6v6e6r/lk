import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingEventLines } from './bookingEventDetails.ts';

test('booking facts preserve selected time, place and whole-court scope', () => {
  const result = bookingEventLines({ date: '2026-11-13', time: '18:00–20:00', location: 'Терехово · Корт 2' }, 'game', 'court');
  assert.equal(result.when, '13 ноября · 18:00–20:00');
  assert.equal(result.where, 'Терехово · Корт 2');
  assert.equal(result.scope, 'Оплата всего корта');
  assert.equal(bookingEventLines(undefined, 'game', 'quarter').scope, 'Моё участие · ¼ стоимости корта');
});
test('missing event facts stay unknown and preformatted header dates are preserved', () => {
  assert.deepEqual(bookingEventLines(undefined, 'game'), { when: 'Дата и время уточняются', where: 'Место уточняется', station: 'Станция уточняется', scope: 'Формат оплаты уточняется' });
  assert.equal(bookingEventLines({ date: 'пятница, 13 ноября', time: '19:00–20:30' }, 'training').when, 'пятница, 13 ноября · 19:00–20:30');
});


test('compact booking station is explicit and excludes district, court and participation scope', () => {
  const result = bookingEventLines({ date: '2026-11-16', time: '11:00–12:00', station: 'Терехово', location: 'Терехово · Тестовая станция · Запад Москвы · Корт 2' }, 'game', 'quarter');
  assert.equal(result.when, '16 ноября · 11:00–12:00');
  assert.equal(result.station, 'Терехово');
  assert.equal(bookingEventLines({ location: 'Станция · район · корт' }, 'training').station, 'Станция уточняется');
});
