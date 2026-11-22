import catalog from './arenas.json' with { type: 'json' };

export const TARGET_TENANT = '005JDA';
const fields = ['tenantKey', 'masterServiceId', 'subServiceId', 'studioId', 'roomId'];
export const arenaData = catalog;
export function assertTenant(tenant) {
  if (tenant !== TARGET_TENANT) throw new Error('Некорректная конфигурация подключения Viva.');
}
export function assertBinding(binding) {
  assertTenant(binding?.tenantKey);
  if (!fields.every(key => typeof binding[key] === 'string' && binding[key])) {
    throw new Error('Запись на эту площадку временно недоступна. Обратитесь к менеджеру.');
  }
  if (!catalog.arenas.some(arena => fields.every(key => arena.viva[key] === binding[key]))) {
    throw new Error('Некорректная конфигурация площадки Viva.');
  }
}
