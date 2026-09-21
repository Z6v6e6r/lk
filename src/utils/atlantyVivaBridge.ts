/**
 * Мост к официальному виджету записи VivaCRM (vc-widget-group-classes).
 *
 * Виджет сам вешает обработчик на ссылки `a[href^="#<instance>"]` и умеет
 * разбирать `exerciseId` в хеше, поэтому карточки — обычные ссылки вида
 * `#atlanty&exerciseId=<uuid>`.
 */

export const ATLANTY_VIVA_INSTANCE = "atlanty";
export const ATLANTY_VIVA_BUNDLE_URL =
  "https://cabinet.vivacrm.ru/vc-widget-group-classes.js";
export const ATLANTY_VIVA_TENANT_KEY = "iSkq6G";
export const ATLANTY_VIVA_TYPE_IDS = [2349] as const;

export function buildAtlantyVivaAnchorHref(
  exerciseId: string,
  instance: string = ATLANTY_VIVA_INSTANCE,
) {
  if (!exerciseId) return `#${instance}`;
  return `#${instance}&exerciseId=${encodeURIComponent(exerciseId)}`;
}

export function getAtlantyExerciseStorageKey(
  instance: string,
  pathname: string,
) {
  return `vc-widget-active-exercise:${instance}:${pathname}`;
}

export function readAtlantyVivaExerciseParam(
  instance: string,
  search: string,
) {
  try {
    const params = new URLSearchParams(search);
    const value = params.get(`${instance}_exercise`);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Запоминает выбранное событие так, как это делает сам виджет Viva:
 * query-параметр `<instance>_exercise` + sessionStorage.
 */
export function rememberAtlantyExercise(
  exerciseId: string,
  instance: string = ATLANTY_VIVA_INSTANCE,
) {
  if (typeof window === "undefined" || !exerciseId) return;

  try {
    window.sessionStorage.setItem(
      getAtlantyExerciseStorageKey(instance, window.location.pathname),
      exerciseId,
    );
  } catch {
    /* приватный режим — виджет всё равно обработает хеш */
  }

  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get(`${instance}_exercise`) !== exerciseId) {
      url.searchParams.set(`${instance}_exercise`, exerciseId);
      window.history.replaceState(null, "", url.toString());
    }
  } catch {
    /* некорректный URL — не блокируем переход по хешу */
  }
}
