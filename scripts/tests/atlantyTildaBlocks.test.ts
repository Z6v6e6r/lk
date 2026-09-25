import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * Витрина для Tilda живёт в двух видах: монолит (`docs/tilda-atlanty-schedule.html`)
 * и четыре блока (`docs/tilda-atlanty/*.html`). Тесты следят, чтобы они не
 * разъехались и чтобы блоки работали в любом порядке.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const MONOLITH = path.join(ROOT, "docs/tilda-atlanty-schedule.html");
const BLOCKS_DIR = path.join(ROOT, "docs/tilda-atlanty");

function read(file: string) {
  return fs.readFileSync(file, "utf8");
}

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

function monolithScripts() {
  const scripts = scriptsOf(read(MONOLITH));
  return {
    config: scripts.find((script) => script.includes("ATLANTY_CATEGORIES")) ?? "",
    loader: scripts.find((script) => script.includes("atlanty-schedule.js")) ?? "",
    popup: scripts.find((script) => script.includes("vc-widget-group-classes.js")) ?? "",
  };
}

type Sandbox = ReturnType<typeof makeSandbox>;

function makeSandbox(options: { readyState?: string } = {}) {
  const appended: Array<{ src: string; parentNode: unknown }> = [];
  const listeners = new Map<string, Array<() => void>>();
  const fetchCalls: string[] = [];

  const makeElement = (tag: string) => {
    const attributes = new Map<string, string>();
    return {
      tagName: String(tag).toUpperCase(),
      id: "",
      style: {} as Record<string, unknown>,
      src: "",
      async: false,
      parentNode: null as unknown,
      setAttribute: (name: string, value: string) => attributes.set(name, String(value)),
      getAttribute: (name: string) => (attributes.has(name) ? attributes.get(name) : null),
      addEventListener: () => {},
      removeEventListener: () => {},
      remove: () => {},
    };
  };

  const documentStub = {
    readyState: options.readyState ?? "complete",
    currentScript: null,
    head: {
      appendChild: (element: { parentNode: unknown }) => {
        appended.push(element as { src: string; parentNode: unknown });
        element.parentNode = documentStub.head;
      },
      removeChild: () => {},
    },
    body: {
      appendChild: (element: { parentNode: unknown }) => {
        appended.push(element as { src: string; parentNode: unknown });
        element.parentNode = documentStub.body;
      },
      removeChild: () => {},
      contains: () => true,
    },
    documentElement: { appendChild: () => {}, removeChild: () => {} },
    createElement: makeElement,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, callback: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(callback);
      listeners.set(type, list);
    },
    removeEventListener: () => {},
  };

  const windowStub: Record<string, unknown> = {
    location: { href: "https://example.test/promo", search: "", hash: "", pathname: "/promo" },
    addEventListener: () => {},
    removeEventListener: () => {},
    history: { replaceState: () => {}, pushState: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    matchMedia: () => ({ matches: false }),
    setTimeout,
    clearTimeout,
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    AbortController,
    Math,
    Date,
    String,
    Number,
    JSON,
    Promise,
    fetch: (url: unknown) => {
      fetchCalls.push(String(url));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ version: "20260922T000000Z" }),
      });
    },
    appended,
    fetchCalls,
  };

  Object.assign(sandbox, {
    dispatch: (type: string) => (listeners.get(type) ?? []).forEach((callback) => callback()),
  });
  (sandbox as unknown as Record<string, unknown>).globalThis = sandbox;
  windowStub.document = documentStub;

  return sandbox as typeof sandbox & { dispatch: (type: string) => void };
}

function runScripts(file: string, sandbox: Sandbox, options: { scripts?: string[] } = {}) {
  const context = vm.createContext(sandbox as unknown as Record<string, unknown>);
  const bodies = options.scripts ?? scriptsOf(read(file));
  bodies.forEach((body, index) => {
    vm.runInContext(body, context, { filename: `${path.basename(file)}#${index}` });
  });
}

function configOf(sandbox: Sandbox) {
  const config = (sandbox.window as Record<string, unknown>).LK_ATLANTY_SCHEDULE_CONFIG as
    | {
      categories?: Array<Record<string, unknown>>;
      maxPerCategory?: number;
      imagePick?: string;
      detailModal?: boolean;
      booking?: string;
      bookingAllowedTypeIds?: number[];
      bookingDirectionIds?: number[];
    }
    | undefined;
  assert.ok(config, "конфиг витрины не задан");
  return config;
}

function popupQueue(sandbox: Sandbox) {
  const widget = (sandbox.window as Record<string, unknown>).atlanty as
    | { q?: Array<[string, Record<string, unknown>]> }
    | undefined;
  return widget?.q ?? [];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Массивы из `vm`-контекста живут в другом realm, поэтому deepEqual их не
 * сравнивает — приводим к строкам.
 */
function sameNumbers(value: unknown, expected: number[]) {
  return JSON.stringify(Array.from((value as number[]) ?? [])) === JSON.stringify(expected);
}

test("блоки побайтово совпадают с соответствующими скриптами монолита", () => {
  const monolith = monolithScripts();
  const settings = scriptsOf(read(path.join(BLOCKS_DIR, "1-settings.html")))[0];
  const schedule = scriptsOf(read(path.join(BLOCKS_DIR, "2-schedule.html")))[0];
  const popup = scriptsOf(read(path.join(BLOCKS_DIR, "3-booking-popup.html")))[0];

  assert.equal(settings, monolith.config);
  assert.equal(schedule, monolith.loader);
  assert.equal(popup, monolith.popup);
  assert.match(read(path.join(BLOCKS_DIR, "2-schedule.html")), /<div id="atlanty-schedule-root"><\/div>/);
});

test("настройки: категории, бейджи и лимиты", () => {
  const sandbox = makeSandbox();
  runScripts(path.join(BLOCKS_DIR, "1-settings.html"), sandbox);
  const config = configOf(sandbox);

  assert.equal(config.categories?.length, 2);
  assert.equal(config.categories?.[0]?.label, "Клубное мероприятие");
  assert.equal(config.categories?.[0]?.badge, "Бесплатно по подписке");
  assert.equal(config.categories?.[1]?.badge, "50% скидка по подписке");
  assert.equal(config.maxPerCategory, 6);
  assert.equal(config.imagePick, "shuffle");
  assert.equal(config.detailModal, true);
  // Страницы Атлантов остаются на попапе Viva.
  assert.equal(config.booking, undefined);
});

test("настройки Топократов включают окно записи ЛК1 и цены клуба", () => {
  const sandbox = makeSandbox();
  runScripts(path.join(ROOT, "docs/topocraty-tilda/1-schedule-settings.html"), sandbox);
  const config = configOf(sandbox);

  assert.equal(config.booking, "lk");
  assert.equal(config.categories?.length, 2);
  assert.equal(config.categories?.[0]?.directionId, 6180);
  assert.equal(config.categories?.[0]?.badge, "По подписке или 2 000 ₽");
  assert.equal(config.categories?.[1]?.directionId, 6233);
  assert.equal(config.categories?.[1]?.badge, "4 000 ₽ или по подписке с доплатой");
  // Тип 2349 вне клубного списка /group — окну записи его нужно передать явно.
  assert.ok(sameNumbers(config.bookingAllowedTypeIds, [2349]));
  assert.ok(sameNumbers(config.bookingDirectionIds, [6180, 6233]));
});

test("витрина ждёт DOMContentLoaded и потом грузит бандл с версией манифеста", async () => {
  const loadingSandbox = makeSandbox({ readyState: "loading" });
  runScripts(path.join(BLOCKS_DIR, "2-schedule.html"), loadingSandbox);
  await wait(20);
  assert.equal(loadingSandbox.fetchCalls.length, 0, "до DOMContentLoaded запросов быть не должно");

  loadingSandbox.dispatch("DOMContentLoaded");
  await wait(30);

  assert.ok(loadingSandbox.fetchCalls.some((url) => url.includes("/lk/release.json")));
  const injected = loadingSandbox.appended.find((element) => String(element.src).includes("atlanty-schedule.js"));
  assert.ok(injected, "бандл витрины не подключён");
  assert.match(String(injected?.src), /v=20260922T000000Z/);
  assert.match(String(injected?.src), /force_ts=/);
});

test("витрина при готовом DOM грузится сразу", async () => {
  const readySandbox = makeSandbox({ readyState: "complete" });
  runScripts(path.join(BLOCKS_DIR, "2-schedule.html"), readySandbox);
  await wait(30);
  assert.ok(readySandbox.fetchCalls.length > 0);
});

test("попап записи ставит init раньше бандла Viva и берёт типы из настроек", () => {
  const sandbox = makeSandbox();
  runScripts(path.join(BLOCKS_DIR, "1-settings.html"), sandbox);
  runScripts(path.join(BLOCKS_DIR, "3-booking-popup.html"), sandbox);

  const queue = popupQueue(sandbox);
  assert.equal(queue.length > 0, true);
  assert.equal(queue[0]?.[0], "init");
  assert.equal(sameNumbers(queue[0]?.[1]?.availableTypes, [2349, 839]), true);
  assert.equal(queue[0]?.[1]?.staticWidgetMode, false);

  assert.ok(
    ((sandbox.window as Record<string, unknown>).__vcGroupClassesInstances as string[] | undefined)
      ?.includes("atlanty"),
  );
  assert.ok(sandbox.appended.some((element) => String(element.src).includes("vc-widget-group-classes.js")));
});

test("без блока настроек попап инициализируется и не ограничивает типы", () => {
  const sandbox = makeSandbox();
  runScripts(path.join(BLOCKS_DIR, "3-booking-popup.html"), sandbox);

  const queue = popupQueue(sandbox);
  assert.equal(queue[0]?.[0], "init");
  assert.equal(queue[0]?.[1]?.availableTypes, undefined);
});

test("попап выше настроек: ждёт DOMContentLoaded и всё равно видит типы", async () => {
  const sandbox = makeSandbox({ readyState: "loading" });
  runScripts(path.join(BLOCKS_DIR, "3-booking-popup.html"), sandbox);
  runScripts(path.join(BLOCKS_DIR, "1-settings.html"), sandbox);

  assert.equal(popupQueue(sandbox).length, 0, "до DOMContentLoaded init не ставится");

  sandbox.dispatch("DOMContentLoaded");
  await wait(20);

  const init = popupQueue(sandbox).find((item) => item[0] === "init");
  assert.equal(sameNumbers(init?.[1]?.availableTypes, [2349, 839]), true);
});

test("монолит ведёт себя как разбитые блоки", async () => {
  const sandbox = makeSandbox({ readyState: "loading" });
  runScripts(MONOLITH, sandbox);
  await wait(20);
  assert.equal(sandbox.fetchCalls.length, 0);

  sandbox.dispatch("DOMContentLoaded");
  await wait(30);

  assert.ok(configOf(sandbox).categories?.length === 2);
  assert.ok(sandbox.fetchCalls.some((url) => url.includes("/lk/release.json")));
  assert.ok(sandbox.appended.some((element) => String(element.src).includes("atlanty-schedule.js")));
  assert.equal(sameNumbers(popupQueue(sandbox)[0]?.[1]?.availableTypes, [2349, 839]), true);
});
