import test from "node:test";
import assert from "node:assert/strict";
import {
  ATLANTY_CORPORATE_DIRECTION_IDS,
  ATLANTY_CORPORATE_TYPE_IDS,
  buildAtlantyPeriodUrl,
  formatAtlantyPlacesLabel,
  getAtlantyDateParts,
  isAtlantyCorporateExercise,
  normalizeAtlantyEvent,
  normalizeAtlantyEventList,
  normalizeAtlantyLevelLabel,
  resolveAtlantyDateFrom,
  resolveAtlantyDateTo,
} from "../../src/utils/atlantyScheduleModel.ts";
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

test("корпоративное расписание определяется по типу 2349 и направлению 6152", () => {
  assert.deepEqual([...ATLANTY_CORPORATE_TYPE_IDS], [2349]);
  assert.deepEqual([...ATLANTY_CORPORATE_DIRECTION_IDS], [6152]);
  assert.equal(isAtlantyCorporateExercise(corporateExercise), true);
  assert.equal(isAtlantyCorporateExercise({ type: { id: "2349", name: "Корпоративные клиенты" } }), true);
  assert.equal(isAtlantyCorporateExercise({ direction: { id: 6152, name: "Атланты" } }), true);
  assert.equal(
    isAtlantyCorporateExercise({ direction: { id: 3686, name: "Групповая тренировка уровень D+" }, type: { id: 605 } }),
    false,
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
