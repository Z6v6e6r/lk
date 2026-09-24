import test from "node:test";
import assert from "node:assert/strict";
import {
  ATLANTY_CATEGORY_PRESETS,
  ATLANTY_CORPORATE_DIRECTION_IDS,
  ATLANTY_CORPORATE_TYPE_IDS,
  buildAtlantyCategoriesSignature,
  buildAtlantyPeriodUrl,
  formatAtlantyPlacesLabel,
  getAtlantyDateParts,
  limitAtlantyEventsPerCategory,
  matchesAtlantyCategories,
  normalizeAtlantyCategories,
  normalizeAtlantyEvent,
  normalizeAtlantyEventList,
  normalizeAtlantyLevelLabel,
  resolveAtlantyDateFrom,
  resolveAtlantyDateTo,
  resolveAtlantyDirectionsParam,
} from "../../src/utils/atlantyScheduleModel.ts";
import {
  ATLANTY_SCHEDULE_FALLBACK_MESSAGE,
  classifyAtlantyFetchError,
  formatAtlantyFailureMessage,
  isAtlantyAbortError,
  shouldRetryAtlantyFailure,
} from "../../src/utils/atlantyScheduleErrors.ts";
import {
  ATLANTY_DEFAULT_DISPLAY_OPTIONS,
  buildAtlantyCardWidth,
  normalizeAtlantyDisplayOptions,
} from "../../src/utils/atlantyScheduleTheme.ts";
import {
  ATLANTY_CARD_IMAGES,
  ATLANTY_CARD_IMAGE_BASE,
  hashAtlantyImageIndex,
  normalizeAtlantyImagePick,
  pickAtlantyCardImage,
  resolveAtlantyCardImages,
  shuffleAtlantyImages,
} from "../../src/utils/atlantyScheduleImages.ts";
import {
  buildAtlantyVivaAnchorHref,
  getAtlantyExerciseStorageKey,
  readAtlantyVivaExerciseParam,
} from "../../src/utils/atlantyVivaBridge.ts";

const corporateExercise = {
  id: "06d61018-5193-4ca3-bc1e-fa2a9f35d908",
  direction: {
    id: 6152,
    name: "Атланты",
    description: "Корпоратинвые мероприятия клуба Атланты",
    photo: null,
    photoWeb: null,
  },
  type: { id: 2349, name: "Корпоративные клиенты", color: "magenta", format: "GROUP" },
  timeFrom: "2026-09-26T10:00:00+03:00",
  timeTo: "2026-09-26T12:00:00+03:00",
  clientsCount: 0,
  maxClientsCount: 12,
  girlsOnly: false,
  studio: { id: "ed0e3bd4-6edb-43a9-8fe4-8fc3e7febec8", name: "Тестовая станция" },
  room: { id: "655358b2-6b6c-4e03-a8a9-c88250464f08", name: "Корт №1 тест панорамик" },
  trainers: [],
  customFields: [],
};

test("по умолчанию витрина берёт корпоративное направление 6152 и тип 2349", () => {
  assert.deepEqual([...ATLANTY_CORPORATE_TYPE_IDS], [2349]);
  assert.deepEqual([...ATLANTY_CORPORATE_DIRECTION_IDS], [6152]);
  assert.equal(matchesAtlantyCategories(corporateExercise), true);
  assert.equal(matchesAtlantyCategories({ direction: { id: 6152, name: "Атланты" } }), true);
  assert.equal(
    matchesAtlantyCategories({ direction: { id: 3686, name: "Групповая тренировка уровень D+" }, type: { id: 605 } }),
    false,
  );
});

test("общий тип не подтягивает события чужого клуба", () => {
  // 2349 «Корпоративные клиенты» есть и у Атлантов (6152), и у Топократов (6180/6233).
  const atlantyOnly = normalizeAtlantyCategories([{ directionId: 6152, typeId: 2349 }]);
  const topocraty = { direction: { id: 6180, name: "Топократы игра" }, type: { id: 2349 } };
  assert.equal(matchesAtlantyCategories(topocraty, { categories: atlantyOnly }), false);

  const topocratyOnly = normalizeAtlantyCategories([
    { directionId: 6180, typeId: 2349 },
    { directionId: 6233, typeId: 2349 },
  ]);
  assert.equal(matchesAtlantyCategories(topocraty, { categories: topocratyOnly }), true);
  assert.equal(
    matchesAtlantyCategories(corporateExercise, { categories: topocratyOnly }),
    false,
  );

  // Категория только по типу (без направления) по-прежнему работает как фильтр типа.
  const byType = normalizeAtlantyCategories([{ typeId: 2349 }]);
  assert.equal(matchesAtlantyCategories(topocraty, { categories: byType }), true);
  assert.equal(matchesAtlantyCategories({ direction: { id: 6180 }, type: { id: 605 } }, { categories: byType }), false);
});

test("категории задаются пресетами, id и объектами", () => {
  assert.equal(ATLANTY_CATEGORY_PRESETS.friends.directionId, 5278);
  assert.equal(ATLANTY_CATEGORY_PRESETS.friends.typeId, 839);

  assert.deepEqual(
    normalizeAtlantyCategories(["atlanty", "friends"]),
    [
      { directionId: 6152, typeId: 2349, label: "Время Атланты", badge: "Бесплатно по подписке" },
      { directionId: 5278, typeId: 839, label: "Время на друзей", badge: "50% скидка по подписке" },
    ],
  );
  assert.deepEqual(
    normalizeAtlantyCategories([6152, "5278", { directionId: 7000, typeId: 900, label: "Время Патриотов" }]),
    [
      { directionId: 6152, typeId: null, label: null, badge: null },
      { directionId: 5278, typeId: null, label: null, badge: null },
      { directionId: 7000, typeId: 900, label: "Время Патриотов", badge: null },
    ],
  );
  // Выключенные, пустые и дубли категории отбрасываются.
  assert.deepEqual(
    normalizeAtlantyCategories([
      { directionId: 6152, enabled: false },
      { label: "без id" },
      "atlanty",
      { preset: "atlanty" },
      null,
    ]),
    [{ directionId: 6152, typeId: 2349, label: "Время Атланты", badge: "Бесплатно по подписке" }],
  );
});

test("бейдж категории попадает в карточку", () => {
  const categories = normalizeAtlantyCategories([
    { directionId: 6152, typeId: 2349, label: "Время Атланты", badge: "Бесплатно по подписке" },
    { directionId: 5278, typeId: 839, label: "Время на друзей", badge: "50% скидка по подписке" },
  ]);
  const atlanty = normalizeAtlantyEvent(corporateExercise, { categories });
  const friends = normalizeAtlantyEvent(
    { ...corporateExercise, id: "f1", direction: { id: 5278, name: "Время на друзей", description: "Игровые турниры" }, type: { id: 839 } },
    { categories },
  );
  assert.equal(atlanty?.badgeLabel, "Бесплатно по подписке");
  assert.equal(friends?.badgeLabel, "50% скидка по подписке");
  assert.equal(friends?.description, "Игровые турниры");
  assert.equal(atlanty?.description, "Корпоратинвые мероприятия клуба Атланты");

  // Без бейджа в конфиге карточка остаётся без бейджа.
  const plain = normalizeAtlantyEvent(corporateExercise, {
    categories: normalizeAtlantyCategories([{ directionId: 6152, typeId: 2349 }]),
  });
  assert.equal(plain?.badgeLabel, null);
});

test("несколько категорий попадают в один запрос, ручной набор не сводится к directions", () => {
  assert.deepEqual(
    resolveAtlantyDirectionsParam(normalizeAtlantyCategories(["atlanty", "friends"])),
    [6152, 5278],
  );
  assert.equal(
    resolveAtlantyDirectionsParam(normalizeAtlantyCategories([{ typeId: 2349 }])),
    null,
  );
  assert.equal(
    buildAtlantyCategoriesSignature(normalizeAtlantyCategories(["atlanty", "friends"])),
    "6152:2349:Время Атланты,5278:839:Время на друзей",
  );
});

test("URL умеет несколько направлений и умеет их не отправлять", () => {
  const base = {
    apiBase: "https://api.vivacrm.ru",
    tenantKey: "iSkq6G",
    dateFrom: "2026-09-21",
    dateTo: "2026-09-28",
  };
  const multi = new URL(buildAtlantyPeriodUrl({ ...base, directionIds: [6152, 5278] }));
  assert.equal(multi.searchParams.get("directions"), "6152,5278");

  const manual = new URL(buildAtlantyPeriodUrl({ ...base, directionIds: null }));
  assert.equal(manual.searchParams.get("directions"), null);
  assert.equal(manual.searchParams.get("dateFrom"), "2026-09-21");
});

test("карточка получает пилюлю своей категории", () => {
  const friendsExercise = {
    ...corporateExercise,
    id: "friends-1",
    direction: { id: 5278, name: "Время на друзей" },
    type: { id: 839, name: "Падел Турнир" },
  };
  const categories = normalizeAtlantyCategories(["atlanty", "friends"]);

  const corporate = normalizeAtlantyEvent(corporateExercise, { categories });
  const friends = normalizeAtlantyEvent(friendsExercise, { categories });
  assert.ok(corporate);
  assert.ok(friends);
  assert.equal(corporate.pillLabel, "Время Атланты");
  assert.equal(friends.pillLabel, "Время на друзей");
  assert.equal(friends.title, "Время на друзей");

  // Категория без label подписывается названием направления.
  const unlabeled = normalizeAtlantyEvent(friendsExercise, {
    categories: normalizeAtlantyCategories([{ directionId: 5278 }]),
  });
  assert.equal(unlabeled?.pillLabel, "Время на друзей");

  // Направление, которого нет в конфиге, в витрину не попадает.
  assert.equal(normalizeAtlantyEvent(friendsExercise, { categories: normalizeAtlantyCategories(["atlanty"]) }), null);
});

test("смешанный список категорий сортируется по дате", () => {
  const now = Date.parse("2026-09-21T00:00:00+03:00");
  const categories = normalizeAtlantyCategories(["atlanty", "friends"]);
  const friendsLater = {
    ...corporateExercise,
    id: "friends-later",
    direction: { id: 5278, name: "Время на друзей" },
    type: { id: 839, name: "Падел Турнир" },
    timeFrom: "2026-10-01T19:00:00+03:00",
    timeTo: "2026-10-01T20:30:00+03:00",
  };
  const friendsSooner = {
    ...friendsLater,
    id: "friends-sooner",
    timeFrom: "2026-09-22T19:00:00+03:00",
    timeTo: "2026-09-22T20:30:00+03:00",
  };

  const events = normalizeAtlantyEventList(
    { content: [friendsLater, corporateExercise, friendsSooner] },
    { now, categories },
  );
  assert.deepEqual(
    events.map((event) => `${event.id}:${event.pillLabel}`),
    [
      "friends-sooner:Время на друзей",
      `06d61018-5193-4ca3-bc1e-fa2a9f35d908:Время Атланты`,
      "friends-later:Время на друзей",
    ],
  );
});

test("URL расписания содержит серверный фильтр directions", () => {
  const url = buildAtlantyPeriodUrl({
    apiBase: "https://api.vivacrm.ru/",
    tenantKey: "iSkq6G",
    dateFrom: "2026-09-21",
    dateTo: "2027-01-19",
    page: 2,
    size: 500,
  });
  assert.match(url, /^https:\/\/api\.vivacrm\.ru\/end-user\/api\/v1\/iSkq6G\/exercises\/period\?/);
  const query = new URL(url).searchParams;
  assert.equal(query.get("directions"), "6152");
  assert.equal(query.get("dateFrom"), "2026-09-21");
  assert.equal(query.get("dateTo"), "2027-01-19");
  assert.equal(query.get("page"), "2");
  assert.equal(query.get("size"), "500");
});

test("окно расписания считается по часовому поясу клуба", () => {
  // 2026-09-21T22:30Z — это уже 22 сентября в Москве.
  assert.equal(resolveAtlantyDateFrom(Date.parse("2026-09-21T22:30:00Z")), "2026-09-22");
  assert.equal(resolveAtlantyDateTo("2026-09-22", 120), "2027-01-20");
});

test("дата и время события раскладываются в формат карточки", () => {
  const parts = getAtlantyDateParts("2026-09-26T10:00:00+03:00");
  assert.deepEqual(parts, {
    date: "2026-09-26",
    dayLabel: "26",
    monthLabel: "сент",
    weekdayLabel: "СБ",
    clock: "10:00",
  });
});

test("корпоративное событие маппится в карточку турнира", () => {
  const event = normalizeAtlantyEvent(corporateExercise);
  assert.ok(event);
  assert.equal(event.id, corporateExercise.id);
  assert.equal(event.title, "Атланты");
  assert.equal(event.dateTimeLabel, "26 сент, 10:00–12:00");
  assert.equal(event.timeRangeLabel, "10:00–12:00");
  assert.equal(event.locationLabel, "Тестовая станция");
  assert.equal(event.levelLabel, null);
  assert.equal(event.slotsLabel, "0/12");
  assert.equal(event.placesLabel, "+12 мест");
  assert.equal(event.isFull, false);
  assert.equal(event.photoUrl, null);
});

test("событие другого направления не попадает в витрину", () => {
  assert.equal(
    normalizeAtlantyEvent({
      id: "x",
      direction: { id: 5278, name: "Время на друзей" },
      type: { id: 839, name: "Падел Турнир" },
      timeFrom: "2026-09-26T10:00:00+03:00",
      timeTo: "2026-09-26T12:00:00+03:00",
      clientsCount: 8,
      maxClientsCount: 10,
    }),
    null,
  );
});

test("заполненная группа помечается как «мест нет»", () => {
  const event = normalizeAtlantyEvent({
    ...corporateExercise,
    clientsCount: 8,
    maxClientsCount: 8,
  });
  assert.ok(event);
  assert.equal(event.slotsLabel, "8/8");
  assert.equal(event.placesLabel, "Мест нет");
  assert.equal(event.isFull, true);
});

test("склонение свободных мест", () => {
  assert.equal(formatAtlantyPlacesLabel(1), "+1 место");
  assert.equal(formatAtlantyPlacesLabel(3), "+3 места");
  assert.equal(formatAtlantyPlacesLabel(7), "+7 мест");
  assert.equal(formatAtlantyPlacesLabel(12), "+12 мест");
  assert.equal(formatAtlantyPlacesLabel(22), "+22 места");
  assert.equal(formatAtlantyPlacesLabel(0), "Мест нет");
  assert.equal(formatAtlantyPlacesLabel(null), null);
});

test("уровень берётся из названия и скрывается, когда данных нет", () => {
  assert.equal(normalizeAtlantyLevelLabel("Тренировка ПРО уровень C/C+"), "C/C+");
  assert.equal(normalizeAtlantyLevelLabel("Игра+Тренер уровень D+"), "D+");
  assert.equal(normalizeAtlantyLevelLabel("Групповая тренировка уровень D - D+"), "D–D+");
  assert.equal(normalizeAtlantyLevelLabel("Время на друзей"), null);
  assert.equal(normalizeAtlantyLevelLabel(null, undefined, ""), null);
});

test("список событий сортируется, дедуплицируется и не показывает прошедшие", () => {
  const now = Date.parse("2026-09-21T00:00:00+03:00");
  const later = { ...corporateExercise, id: "later", timeFrom: "2026-10-05T19:00:00+03:00", timeTo: "2026-10-05T21:00:00+03:00" };
  const sooner = { ...corporateExercise, id: "sooner" };
  const past = { ...corporateExercise, id: "past", timeFrom: "2026-09-01T10:00:00+03:00", timeTo: "2026-09-01T12:00:00+03:00" };
  const foreign = { ...corporateExercise, id: "foreign", direction: { id: 3685, name: "Групповая тренировка уровень D" }, type: { id: 605 } };

  const events = normalizeAtlantyEventList(
    { content: [later, past, foreign, sooner, { ...sooner }] },
    { now },
  );
  assert.deepEqual(events.map((event) => event.id), ["sooner", "later"]);
});

test("квота по категориям не даёт плотной категории вытеснить редкую", () => {
  const categories = normalizeAtlantyCategories(["atlanty", "friends"]);
  const now = Date.parse("2026-09-21T00:00:00+03:00");
  const dense = Array.from({ length: 10 }, (_, index) => ({
    ...corporateExercise,
    id: `friends-${index}`,
    direction: { id: 5278, name: "Время на друзей" },
    type: { id: 839, name: "Падел Турнир" },
    timeFrom: `2026-09-2${(index % 8) + 2}T19:00:00+03:00`,
    timeTo: `2026-09-2${(index % 8) + 2}T20:30:00+03:00`,
  }));
  const rare = { ...corporateExercise, id: "rare-atlanty" };

  const sorted = normalizeAtlantyEventList({ content: [...dense, rare] }, { now, categories });
  assert.equal(sorted.length, 11);

  // Без квоты редкое событие выпадает из первых 6 карточек.
  const withoutQuota = limitAtlantyEventsPerCategory(sorted, 0, 6);
  assert.equal(withoutQuota.some((event) => event.id === "rare-atlanty"), false);

  // С квотой 3 на категорию редкая категория гарантированно представлена.
  const withQuota = limitAtlantyEventsPerCategory(sorted, 3, 24);
  assert.equal(withQuota.length, 4);
  assert.equal(withQuota.filter((event) => event.pillLabel === "Время на друзей").length, 3);
  assert.equal(withQuota.filter((event) => event.pillLabel === "Время Атланты").length, 1);

  // Общий лимит maxEvents всё ещё действует.
  assert.equal(limitAtlantyEventsPerCategory(sorted, 3, 2).length, 2);
});

test("опции внешнего вида нормализуются и не ломают значения по умолчанию", () => {
  assert.deepEqual(normalizeAtlantyDisplayOptions(null), ATLANTY_DEFAULT_DISPLAY_OPTIONS);
  assert.deepEqual(normalizeAtlantyDisplayOptions(undefined), ATLANTY_DEFAULT_DISPLAY_OPTIONS);

  assert.deepEqual(
    normalizeAtlantyDisplayOptions({
      pillIcon: "USERS",
      avatarMode: "none",
      seatsStyle: "plain",
      levelStyle: "chip",
      cardsPerView: "4",
    }),
    { pillIcon: "users", avatarMode: "none", seatsStyle: "plain", levelStyle: "chip", cardsPerView: 4 },
  );

  // Неизвестные значения откатываются к дефолту, а не ломают карточку.
  assert.deepEqual(
    normalizeAtlantyDisplayOptions({
      pillIcon: "sparkles",
      avatarMode: "initials",
      seatsStyle: "fancy",
      levelStyle: "badge",
      cardsPerView: "много",
    }),
    ATLANTY_DEFAULT_DISPLAY_OPTIONS,
  );
});

test("режим «N в ряд» считается от gap и ограничен сверху", () => {
  assert.equal(buildAtlantyCardWidth(0), null);
  assert.equal(buildAtlantyCardWidth(1), null);
  assert.equal(
    buildAtlantyCardWidth(4),
    "calc((100% - 3 * var(--atlanty-gap)) / 4)",
  );
  assert.equal(normalizeAtlantyDisplayOptions({ cardsPerView: 99 }).cardsPerView, 6);
  assert.equal(normalizeAtlantyDisplayOptions({ cardsPerView: -3 }).cardsPerView, 0);
});

test("сырой AbortError не попадает в интерфейс", () => {
  const abortError = Object.assign(new Error("signal is aborted without reason"), {
    name: "AbortError",
  });
  assert.equal(isAtlantyAbortError(abortError), true);

  // Наш таймаут — понятное сообщение вместо текста браузера.
  const timeout = classifyAtlantyFetchError(abortError, { timedOut: true });
  assert.equal(timeout.kind, "timeout");
  assert.match(timeout.message, /не ответил/);
  assert.doesNotMatch(timeout.message, /aborted/i);

  // Отмена вызывающей стороной — ошибку показывать не нужно.
  const aborted = classifyAtlantyFetchError(abortError, { callerAborted: true });
  assert.equal(aborted.kind, "aborted");
  assert.equal(aborted.message, "");

  // Неожиданный обрыв без отмены и без нашего таймаута — это сетевой сбой,
  // а не «тихая отмена»: иначе витрина молча останется в скелетоне.
  const unexpected = classifyAtlantyFetchError(abortError);
  assert.equal(unexpected.kind, "network");
  assert.ok(unexpected.message.length > 0);

  // HTTP-код и обрыв связи — тоже человеческие тексты.
  const http = classifyAtlantyFetchError(Object.assign(new Error("boom"), { status: 503 }));
  assert.equal(http.kind, "http");
  assert.equal(http.status, 503);
  assert.match(http.message, /503/);

  const network = classifyAtlantyFetchError(new TypeError("Failed to fetch"));
  assert.equal(network.kind, "network");
  assert.match(network.message, /Нет связи/);
  assert.match(network.reason, /Failed to fetch/);

  assert.equal(formatAtlantyFailureMessage("timeout"), timeout.message);
  assert.ok(ATLANTY_SCHEDULE_FALLBACK_MESSAGE.length > 0);
});

test("повтор запроса только для восстановимых отказов", () => {
  assert.equal(shouldRetryAtlantyFailure("timeout"), true);
  assert.equal(shouldRetryAtlantyFailure("network"), true);
  assert.equal(shouldRetryAtlantyFailure("aborted"), false);
  assert.equal(shouldRetryAtlantyFailure("http"), false);
});

test("пул фото раскладывается в абсолютные URL без дублей", () => {
  const pool = resolveAtlantyCardImages(undefined);
  assert.equal(pool.length, ATLANTY_CARD_IMAGES.length);
  assert.equal(pool.length, 28);
  assert.ok(pool.every((url) => url.startsWith(ATLANTY_CARD_IMAGE_BASE)));
  assert.ok(pool.includes(`${ATLANTY_CARD_IMAGE_BASE}hero-tournament.webp`));

  const custom = resolveAtlantyCardImages([
    "my-photo.webp",
    "https://example.test/abs.png",
    "/local/root.webp",
    "my-photo.webp",
    42,
  ]);
  assert.deepEqual(custom, [
    `${ATLANTY_CARD_IMAGE_BASE}my-photo.webp`,
    "https://example.test/abs.png",
    "/local/root.webp",
  ]);
  assert.deepEqual(resolveAtlantyCardImages([]), []);
});

test("перемешивание сохраняет состав и воспроизводится с тем же random", () => {
  const pool = ["a", "b", "c", "d", "e"];
  const sequence = () => {
    const values = [0.1, 0.7, 0.3, 0.9, 0.5];
    let index = 0;
    return () => values[index++ % values.length];
  };
  const first = shuffleAtlantyImages(pool, sequence());
  const second = shuffleAtlantyImages(pool, sequence());
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, pool);
  assert.deepEqual([...first].sort(), [...pool].sort());
});

test("фото на карточке: перемешивание по позиции и стабильный hash по id", () => {
  const pool = ["a.webp", "b.webp", "c.webp"];

  assert.equal(normalizeAtlantyImagePick("hash"), "hash");
  assert.equal(normalizeAtlantyImagePick("shuffle"), "shuffle");
  assert.equal(normalizeAtlantyImagePick("что-то"), "shuffle");

  // Перемешивание: соседние карточки получают разные фото, индекс зацикливается.
  assert.equal(pickAtlantyCardImage({ images: pool, seed: "x", index: 0 }), "a.webp");
  assert.equal(pickAtlantyCardImage({ images: pool, seed: "x", index: 2 }), "c.webp");
  assert.equal(pickAtlantyCardImage({ images: pool, seed: "x", index: 3 }), "a.webp");

  // Hash-режим: одинаковый id — одинаковое фото, в пределах пула.
  const first = pickAtlantyCardImage({ images: pool, seed: "event-1", index: 0, pick: "hash" });
  const again = pickAtlantyCardImage({ images: pool, seed: "event-1", index: 2, pick: "hash" });
  assert.equal(first, again);
  assert.ok(pool.includes(first as string));
  assert.ok(hashAtlantyImageIndex("event-1", 3) >= 0 && hashAtlantyImageIndex("event-1", 3) < 3);
  assert.equal(hashAtlantyImageIndex("event-1", 0), 0);

  assert.equal(pickAtlantyCardImage({ images: [], seed: "x", index: 0 }), null);
});

test("без модалки карточка остаётся ссылкой на попап записи", () => {
  // Проверяем контракт: с включённой модалкой карточка — кнопка,
  // без неё — прежняя ссылка #atlanty&exerciseId=…
  const href = buildAtlantyVivaAnchorHref("06d61018-5193-4ca3-bc1e-fa2a9f35d908");
  assert.equal(href, "#atlanty&exerciseId=06d61018-5193-4ca3-bc1e-fa2a9f35d908");
});

test("карточка ссылается на виджет записи Viva", () => {
  assert.equal(
    buildAtlantyVivaAnchorHref("06d61018-5193-4ca3-bc1e-fa2a9f35d908"),
    "#atlanty&exerciseId=06d61018-5193-4ca3-bc1e-fa2a9f35d908",
  );
  assert.equal(buildAtlantyVivaAnchorHref("", "atlanty"), "#atlanty");
  assert.equal(
    getAtlantyExerciseStorageKey("atlanty", "/korporativ"),
    "vc-widget-active-exercise:atlanty:/korporativ",
  );
  assert.equal(
    readAtlantyVivaExerciseParam("atlanty", "?atlanty_exercise=abc-123&x=1"),
    "abc-123",
  );
  assert.equal(readAtlantyVivaExerciseParam("atlanty", "?rjj_exercise=abc-123"), null);
});
