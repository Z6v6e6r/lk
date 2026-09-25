import test from "node:test";
import assert from "node:assert/strict";

import {
  ATLANTY_LK_BOOKING_BODY_CLASS,
  ATLANTY_LK_BOOKING_OVERLAY_ID,
  ATLANTY_LK_BOOKING_SCRIPT_ID,
  buildAtlantyLkBookingMountData,
  buildAtlantyLkBookingReleaseUrl,
  buildAtlantyLkBookingScope,
  buildAtlantyLkBookingScriptUrl,
  clearAtlantyLkBookingReturn,
  isAtlantyLkBookingWindowOpen,
  normalizeAtlantyLkBookingOrigins,
  openAtlantyLkBookingWindow,
  readAtlantyLkBookingReturn,
  resetAtlantyLkBookingWindowState,
  resumeAtlantyLkBookingReturn,
} from "../../src/utils/atlantyLkBookingWindow.ts";

/**
 * Окно записи LK1 на витрине: карточка обязана открывать ЛК-запись, а не попап
 * Viva, поэтому тесты держат и сборку URL бандла, и жизненный цикл оверлея.
 */

test("normalizes bundle origins with the CDN first and without duplicates", () => {
  // Резервный (dev) origin не подставляется: он отдаёт 404 на prod-имя бандла.
  assert.deepEqual(normalizeAtlantyLkBookingOrigins(), ["https://padlhub.su"]);
  assert.deepEqual(
    normalizeAtlantyLkBookingOrigins("https://padlhub.su/", ["https://padlhub.su", "https://lk.example/"]),
    ["https://padlhub.su", "https://lk.example"],
  );
  assert.deepEqual(normalizeAtlantyLkBookingOrigins(null, ["  "]), ["https://padlhub.su"]);
  assert.deepEqual(
    normalizeAtlantyLkBookingOrigins(null, ["https://reserve.example/"]),
    ["https://padlhub.su", "https://reserve.example"],
  );
});

test("builds versioned bundle and manifest urls", () => {
  const scriptUrl = new URL(
    buildAtlantyLkBookingScriptUrl("https://padlhub.su/", {
      version: "20260924T134737Z",
      cacheBust: "42",
    }),
  );
  assert.equal(scriptUrl.origin, "https://padlhub.su");
  assert.equal(scriptUrl.pathname, "/lk/group-schedule.js");
  assert.equal(scriptUrl.searchParams.get("v"), "20260924T134737Z");
  assert.equal(scriptUrl.searchParams.get("force_ts"), "42");

  const releaseUrl = new URL(buildAtlantyLkBookingReleaseUrl("https://padlhub.su", "42"));
  assert.equal(releaseUrl.pathname, "/lk/release.json");
  assert.equal(releaseUrl.searchParams.get("force_ts"), "42");

  assert.equal(
    buildAtlantyLkBookingScriptUrl("https://padlhub.su").includes("v="),
    false,
  );
});

test("builds the mount scope for corporate showcases", () => {
  assert.equal(buildAtlantyLkBookingScope({}), null);
  assert.equal(buildAtlantyLkBookingScope({ allowedTypeIds: [] }), null);
  assert.deepEqual(buildAtlantyLkBookingScope({ allowedTypeIds: [2349, 2349, NaN] }), {
    allowedTypeIds: [2349],
    availableStudioIds: [],
  });

  assert.deepEqual(
    buildAtlantyLkBookingMountData({
      exerciseId: "exercise-1",
      directionIds: [6180, 6233, "x" as unknown as number],
      directionLabel: "  Топократы  ",
      allowedTypeIds: [2349],
    }),
    {
      exerciseId: "exercise-1",
      directionIds: [6180, 6233],
      directionLabel: "Топократы",
      returnToFindGame: true,
      scope: { allowedTypeIds: [2349], availableStudioIds: [] },
    },
  );

  // Без типов витрины окно работает как штатное и не сужает список.
  assert.deepEqual(
    buildAtlantyLkBookingMountData({ exerciseId: "exercise-2", directionIds: [] }),
    { exerciseId: "exercise-2", directionIds: null, directionLabel: null, returnToFindGame: true },
  );
});

test("reads and clears the payment return params", () => {
  assert.deepEqual(
    readAtlantyLkBookingReturn(
      "https://padlhub.ru/topocraty?groupExerciseId=exercise-1&groupPaymentSuccess=true",
    ),
    { exerciseId: "exercise-1", status: "success" },
  );
  assert.deepEqual(
    readAtlantyLkBookingReturn(
      "https://padlhub.ru/topocraty?groupExerciseId=exercise-1&groupPaymentFailed=true",
    ),
    { exerciseId: "exercise-1", status: "failed" },
  );
  assert.equal(readAtlantyLkBookingReturn("https://padlhub.ru/topocraty"), null);
  assert.equal(
    readAtlantyLkBookingReturn("https://padlhub.ru/topocraty?groupPaymentSuccess=true"),
    null,
  );

  assert.equal(
    clearAtlantyLkBookingReturn(
      "https://padlhub.ru/topocraty?groupExerciseId=exercise-1&groupPaymentSuccess=true&keep=1#events",
    ),
    "/topocraty?keep=1#events",
  );
});

type FakeElement = {
  tagName: string;
  id: string;
  className: string;
  innerHTML: string;
  textContent: string;
  src: string;
  async: boolean;
  crossOrigin: string;
  parentNode: FakeElement | null;
  children: FakeElement[];
  style: Record<string, string>;
  classList: { add: (name: string) => void; remove: (name: string) => void; contains: (name: string) => boolean };
  appendChild: (child: FakeElement) => FakeElement;
  setAttribute: (name: string, value: string) => void;
  querySelectorAll: (selector: string) => FakeElement[];
  remove: () => void;
  onload?: (() => void) | null;
  onerror?: (() => void) | null;
};

function makeElement(tagName: string): FakeElement {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const element: FakeElement = {
    tagName: tagName.toUpperCase(),
    id: "",
    className: "",
    innerHTML: "",
    textContent: "",
    src: "",
    async: false,
    crossOrigin: "",
    parentNode: null,
    children: [],
    style: {},
    classList: {
      add: (name) => {
        classes.add(name);
        element.className = [...classes].join(" ");
      },
      remove: (name) => {
        classes.delete(name);
        element.className = [...classes].join(" ");
      },
      contains: (name) => classes.has(name),
    },
    appendChild: (child) => {
      element.children.push(child);
      child.parentNode = element;
      return child;
    },
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    querySelectorAll: () => [],
    remove: () => {
      if (!element.parentNode) return;
      element.parentNode.children = element.parentNode.children.filter((item) => item !== element);
      element.parentNode = null;
    },
    onload: null,
    onerror: null,
  };
  return element;
}

async function waitFor<T>(predicate: () => T | undefined | null, timeoutMs = 1_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor: условие не выполнено");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Бандл не регистрирует окно: тест закрывает попытку за попыткой, не дожидаясь
 * 15-секундного таймаута скрипта. По умолчанию origin один — резервный
 * (dev) origin в prod-режиме не подставляется.
 */
async function failEveryBundleAttempt(
  dom: ReturnType<typeof installDom>,
  attempts = 1,
) {
  for (let index = 0; index < attempts; index += 1) {
    const script = await waitFor(() =>
      dom.appendedScripts.filter((item) => item.id === ATLANTY_LK_BOOKING_SCRIPT_ID)[index]);
    script.onload?.();
  }
  return dom.appendedScripts.filter((item) => item.id === ATLANTY_LK_BOOKING_SCRIPT_ID);
}

function installDom(options: { href?: string } = {}) {
  const elements = new Map<string, FakeElement>();
  const bodyClasses = new Set<string>();
  const appendedScripts: FakeElement[] = [];
  const listeners = new Map<string, Array<(event: { key: string; preventDefault: () => void }) => void>>();
  const head = makeElement("head");

  const body: FakeElement & { classList: FakeElement["classList"] } = Object.assign(makeElement("body"), {
    classList: {
      add: (name: string) => {
        bodyClasses.add(name);
      },
      remove: (name: string) => {
        bodyClasses.delete(name);
      },
      contains: (name: string) => bodyClasses.has(name),
    },
  });

  const documentStub = {
    head,
    body,
    documentElement: makeElement("html"),
    createElement: (tagName: string) => makeElement(tagName),
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: (type: string, handler: (event: { key: string; preventDefault: () => void }) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, handler: (event: { key: string; preventDefault: () => void }) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== handler));
    },
  };

  const originalAppend = body.appendChild;
  body.appendChild = (child: FakeElement) => {
    const appended = originalAppend(child);
    if (child.id) elements.set(child.id, child);
    return appended;
  };
  head.appendChild = (child: FakeElement) => {
    appendedScripts.push(child);
    head.children.push(child);
    child.parentNode = head;
    return child;
  };
  head.querySelectorAll = (selector: string) => (selector === "style"
    ? head.children.filter((child) => child.tagName === "STYLE")
    : []);

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const historyCalls: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: options.href ?? "https://padlhub.ru/topocraty" },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          historyCalls.push(url);
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });

  return {
    bodyClasses,
    appendedScripts,
    listeners,
    head,
    historyCalls,
    restore: () => {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    },
  };
}

test("opens the LK booking window in an overlay and closes it", async () => {
  resetAtlantyLkBookingWindowState();
  const dom = installDom();
  const fetchCalls: string[] = [];
  const previousFetch = globalThis.fetch;
  const widgetWindow = globalThis.window as unknown as Record<string, unknown>;
  const mountCalls: Array<{ targetId?: string; data?: unknown }> = [];
  let closeHandler: (() => void) | null = null;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => ({ version: "20260924T134737Z" }) };
    },
  });

  try {
    const closed: string[] = [];
    const pending = openAtlantyLkBookingWindow({
      exerciseId: "exercise-1",
      directionIds: [6180],
      allowedTypeIds: [2349],
      onClosed: () => closed.push("closed"),
    });

    // Бандл окна появляется после загрузки скрипта — эмулируем его onload.
    const script = await waitFor(() =>
      dom.appendedScripts.find((item) => item.id === ATLANTY_LK_BOOKING_SCRIPT_ID));
    assert.match(script.src, /\/lk\/group-schedule\.js\?v=20260924T134737Z/);
    assert.ok(fetchCalls.some((url) => url.includes("/lk/release.json")));

    widgetWindow.LKWidgetGroupSchedule = {
      mount: (options?: { targetId?: string; data?: unknown; onClose?: () => void }) => {
        mountCalls.push({ targetId: options?.targetId, data: options?.data });
        closeHandler = options?.onClose ?? null;
      },
      unmount: () => {
        closeHandler = null;
      },
    };
    // Бандл окна инжектит глобальные стили ЛК в head — как это делает
    // cssInjectedByJsPlugin в собранном `group-schedule.js`. Стиль Tilda,
    // добавленный в это же время, снимать нельзя.
    const tildaStyle = makeElement("style");
    tildaStyle.textContent = "#rec1 .t-title{font-size:40px}";
    dom.head.appendChild(tildaStyle);
    const lkStyle = makeElement("style");
    lkStyle.textContent = ":root{--community-primary-gradient:linear-gradient(#000,#fff)}body{background:#F5F5F7}";
    dom.head.appendChild(lkStyle);
    script.onload?.();

    const result = await pending;
    assert.deepEqual(result, { ok: true });

    const overlay = (globalThis.document as unknown as { getElementById: (id: string) => FakeElement | null })
      .getElementById(ATLANTY_LK_BOOKING_OVERLAY_ID);
    assert.ok(overlay, "ожидается оверлей окна записи");
    assert.equal(overlay.classList.contains("open"), true);
    assert.equal(overlay.style.display, "block");
    assert.equal(dom.bodyClasses.has(ATLANTY_LK_BOOKING_BODY_CLASS), true);
    assert.equal(isAtlantyLkBookingWindowOpen(), true);
    assert.equal(mountCalls[0]?.targetId, ATLANTY_LK_BOOKING_OVERLAY_ID);
    assert.deepEqual(mountCalls[0]?.data, {
      exerciseId: "exercise-1",
      directionIds: [6180],
      directionLabel: null,
      returnToFindGame: true,
      scope: { allowedTypeIds: [2349], availableStudioIds: [] },
    });
    // Пока окно открыто, стили ЛК подключены (стиль Tilda остаётся на месте).
    assert.equal(dom.head.querySelectorAll("style").length, 2);
    assert.ok(dom.head.querySelectorAll("style").includes(lkStyle));

    // Escape закрывает окно так же, как кнопка «Назад» внутри него.
    (dom.listeners.get("keydown") ?? []).forEach((handler) => handler({ key: "Escape", preventDefault: () => {} }));
    assert.equal(isAtlantyLkBookingWindowOpen(), false);
    assert.equal(dom.bodyClasses.has(ATLANTY_LK_BOOKING_BODY_CLASS), false);
    assert.equal(overlay.style.display, "none");
    // Глобальные стили ЛК сняты: лендинг под окном не переоформляется.
    assert.deepEqual(dom.head.querySelectorAll("style"), [tildaStyle]);
    assert.deepEqual(closed, ["closed"]);

    // Повторное открытие переиспользует уже загруженный бандл, возвращает стили,
    // а кнопка «Назад» внутри окна закрывает оверлей через переданный onClose.
    const secondOpen = await openAtlantyLkBookingWindow({
      exerciseId: "exercise-2",
      onClosed: () => closed.push("closed-2"),
    });
    assert.deepEqual(secondOpen, { ok: true });
    assert.equal(dom.head.querySelectorAll("style").length, 2);
    assert.ok(closeHandler, "окно должно получить обработчик закрытия");
    (closeHandler as unknown as () => void)();
    assert.equal(isAtlantyLkBookingWindowOpen(), false);
    assert.deepEqual(dom.head.querySelectorAll("style"), [tildaStyle]);
    assert.deepEqual(closed, ["closed", "closed-2"]);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    dom.restore();
    resetAtlantyLkBookingWindowState();
  }
});

test("reports a failure when the booking bundle never registers the widget", async () => {
  resetAtlantyLkBookingWindowState();
  const dom = installDom();
  const previousFetch = globalThis.fetch;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: true, json: async () => ({ version: "v1" }) }),
  });

  try {
    const pending = openAtlantyLkBookingWindow({ exerciseId: "exercise-1" });
    const attempts = await failEveryBundleAttempt(dom);
    assert.equal(attempts.length, 1, "prod-витрина использует только свой origin");

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(isAtlantyLkBookingWindowOpen(), false);
    assert.equal(dom.bodyClasses.has(ATLANTY_LK_BOOKING_BODY_CLASS), false);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    dom.restore();
    resetAtlantyLkBookingWindowState();
  }
});

test("rejects an empty exercise id without touching the page", async () => {
  resetAtlantyLkBookingWindowState();
  const result = await openAtlantyLkBookingWindow({ exerciseId: "   " });
  assert.deepEqual(result, { ok: false, message: "Событие не выбрано." });
});

test("parallel opens share one bundle load and one overlay mount", async () => {
  resetAtlantyLkBookingWindowState();
  const dom = installDom();
  const previousFetch = globalThis.fetch;
  const widgetWindow = globalThis.window as unknown as Record<string, unknown>;
  let mountCount = 0;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: true, json: async () => ({ version: "v1" }) }),
  });

  try {
    const first = openAtlantyLkBookingWindow({ exerciseId: "exercise-1" });
    const second = openAtlantyLkBookingWindow({ exerciseId: "exercise-1" });
    const script = await waitFor(() =>
      dom.appendedScripts.find((item) => item.id === ATLANTY_LK_BOOKING_SCRIPT_ID));
    widgetWindow.LKWidgetGroupSchedule = {
      mount: () => {
        mountCount += 1;
      },
      unmount: () => {},
    };
    script.onload?.();

    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await second, { ok: true });
    assert.equal(mountCount, 1, "окно должно смонтироваться один раз");
    assert.equal(
      dom.appendedScripts.filter((item) => item.id === ATLANTY_LK_BOOKING_SCRIPT_ID).length,
      1,
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    dom.restore();
    resetAtlantyLkBookingWindowState();
  }
});

test("payment return resumes the window and clears the url only on success", async () => {
  resetAtlantyLkBookingWindowState();
  const dom = installDom({
    href: "https://padlhub.ru/topocraty?groupExerciseId=exercise-9&groupPaymentSuccess=true&keep=1",
  });
  const previousFetch = globalThis.fetch;
  const widgetWindow = globalThis.window as unknown as Record<string, unknown>;
  const mountData: unknown[] = [];

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: true, json: async () => ({ version: "v1" }) }),
  });

  try {
    const pending = resumeAtlantyLkBookingReturn({ allowedTypeIds: [2349] });
    const script = await waitFor(() =>
      dom.appendedScripts.find((item) => item.id === ATLANTY_LK_BOOKING_SCRIPT_ID));
    widgetWindow.LKWidgetGroupSchedule = {
      mount: (options?: { data?: unknown }) => {
        mountData.push(options?.data);
      },
      unmount: () => {},
    };
    script.onload?.();

    assert.equal(await pending, "opened");
    assert.deepEqual(mountData, [{
      exerciseId: "exercise-9",
      directionIds: null,
      directionLabel: null,
      returnToFindGame: true,
      scope: { allowedTypeIds: [2349], availableStudioIds: [] },
    }]);
    assert.deepEqual(dom.historyCalls, ["/topocraty?keep=1"]);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    dom.restore();
    resetAtlantyLkBookingWindowState();
  }
});

test("failed payment return keeps the url so the next load can retry", async () => {
  resetAtlantyLkBookingWindowState();
  const dom = installDom({
    href: "https://padlhub.ru/topocraty?groupExerciseId=exercise-9&groupPaymentFailed=true",
  });
  const previousFetch = globalThis.fetch;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: true, json: async () => ({ version: "v1" }) }),
  });

  try {
    const pending = resumeAtlantyLkBookingReturn();
    // Бандл не зарегистрировал окно ни на основном, ни на резервном origin'е.
    await failEveryBundleAttempt(dom);

    assert.equal(await pending, "failed");
    assert.deepEqual(dom.historyCalls, [], "параметры оплаты нельзя стирать при сбое");
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    dom.restore();
    resetAtlantyLkBookingWindowState();
  }
});

test("payment return without params does not load the window bundle", async () => {
  resetAtlantyLkBookingWindowState();
  const dom = installDom({ href: "https://padlhub.ru/topocraty?keep=1" });

  try {
    assert.equal(await resumeAtlantyLkBookingReturn(), "none");
    assert.deepEqual(dom.appendedScripts, []);
    assert.deepEqual(dom.historyCalls, []);
  } finally {
    dom.restore();
    resetAtlantyLkBookingWindowState();
  }
});
