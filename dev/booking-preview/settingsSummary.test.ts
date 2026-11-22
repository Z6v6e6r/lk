import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsSummary } from './settingsSummary.ts';

test('a summary separates a selected purchase tariff from an actually owned subscription', () => {
  const params = new URLSearchParams('stage=current&subscription=0&subscriptionPlan=ra&boost=1');
  const without = settingsSummary(params);
  assert.ok(without.includes('Без подписки · тариф РА'));
  assert.ok(!without.includes('РАбуста'));
  params.set('subscription', '1');
  assert.ok(settingsSummary(params).includes('Подписка РА'));
});

test('summary follows Boost usage, profile products, quota and event exceptions', () => {
  const summary = settingsSummary(new URLSearchParams('stage=full&subscription=1&subscriptionPlan=friendship-2&residency=1&pass=1&passRemaining=2&passFits=1&boost=1&dailyUsage=game-hour&dailyQuota=used&activeLimitExceeded=1&groupCategory=pro&friendsTournament=1'));
  for (const item of ['Подписка Дружба 2.0', 'Резидентство', 'Энергия 5 · остаток 2', 'РАбуста', 'Сегодня: Игра · 1 час', 'Больше 8 активных записей', 'ПРО', 'Время на друзей']) assert.ok(summary.includes(item), item);
});

test('Energy summary respects its ordinary tournament exception and validated balance', () => {
  const params = new URLSearchParams('pass=1&passRemaining=invalid&passFits=0&screen=training-join');
  assert.ok(settingsSummary(params).includes('Энергия 5 · остаток 0 · не подходит'));
  params.set('screen', 'tournament-join');
  assert.ok(settingsSummary(params).includes('Энергия 5 · остаток 0'));
  params.set('screen', 'matrix');
  assert.ok(settingsSummary(params).includes('Энергия 5 · остаток 0 · только обычные турниры'));
});
