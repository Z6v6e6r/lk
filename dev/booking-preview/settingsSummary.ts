import { readMatrixSettings, energyPassApplies } from './paymentMatrix.ts';
import { readPassRemaining } from './bookingCheckout.ts';
import { DAILY_USAGE, SUBSCRIPTION_PLANS } from './privilegeRules.ts';
import { readPreviewStage } from './previewStage.ts';
import { readPreviewSkin } from './previewSkin.ts';

export function settingsSummary(params: URLSearchParams): string[] {
  const settings = readMatrixSettings(params);
  const stage = readPreviewStage(params);
  const plan = SUBSCRIPTION_PLANS.find(plan => plan.id === settings.subscriptionPlan)?.name || 'Дружба';
  const items = [stage === 'current' ? 'Сейчас · без РАбуста' : 'Полный вариант'];
  items.push(readPreviewSkin(params) === 'lk2' ? 'Скин LK2' : 'Текущий скин');
  items.push(settings.profile.subscription ? `Подписка ${plan}` : `Без подписки · тариф ${plan}`);
  if (settings.profile.residency) items.push('Резидентство');
  if (settings.profile.pass) {
    const screen = params.get('screen') || '';
    const service = screen.startsWith('tournament') ? 'tournament' : screen.startsWith('training') ? 'training' : 'game';
    const fits = energyPassApplies(service, settings.applicability.pass, settings);
    const availability = screen === 'matrix' && !settings.applicability.pass ? ' · только обычные турниры' : fits ? '' : ' · не подходит';
    items.push(`Энергия 5 · остаток ${readPassRemaining(params)}${availability}`);
  }
  if (settings.boost) items.push('РАбуста');
  const usage = DAILY_USAGE.find(usage => usage.id === settings.dailyUsage);
  items.push(settings.boost && usage && usage.id !== 'none' ? `Сегодня: ${usage.name}`
    : settings.dailyQuota === 'used' ? 'Дневной лимит использован' : 'Дневной лимит доступен');
  if (settings.activeLimitExceeded) items.push('Больше 8 активных записей');
  items.push(settings.proDirection ? 'ПРО' : settings.excludedGroups ? 'Групповые без подписки и Резидентства' : 'Обычное направление');
  if (settings.friendsTournament) items.push('Время на друзей');
  return items;
}
