import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transformSync } from "esbuild";

const compile = (source, options = {}) => transformSync(source, {
  loader: "tsx", format: "cjs", jsxFactory: "createElement", ...options,
}).code;
const lifecycleModule = { exports: {} };
new Function("module", "exports", compile(fs.readFileSync("src/utils/overlayLifecycle.ts", "utf8")))(
  lifecycleModule, lifecycleModule.exports,
);
const { createOverlayLifecycle } = lifecycleModule.exports;
const app = fs.readFileSync("src/MyApp.tsx", "utf8");
const globals = app.slice(app.indexOf('const OVERLAY_ID = "lk-overlay";'), app.indexOf("function normalizeInviteCabinetUrl"));
const openStart = app.indexOf("  const openOverlayModule = useCallback(async (");
const opener = app.slice(openStart, app.indexOf("  }, []);", openStart) + "  }, []);".length)
  .replace(/import\(("[^"\n]+")\)/g, "loadDevModule($1)");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(dev = false) {
  const frames = [], log = [], events = [], errors = [], requests = [], imports = [];
  let container;
  const element = () => ({
    children: [], classList: { add() {}, remove() {} },
    set innerHTML(value) { this.children = [{ value }]; log.push("loading"); },
    set textContent(value) { this.children = value ? [{ value }] : []; log.push("clear"); },
    replaceChildren(...children) { this.children = children; log.push("replace"); },
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index < 0) throw new Error("NotFoundError: removeChild");
      this.children.splice(index, 1);
    },
  });
  const document = {
    createElement: element,
    getElementById: () => container,
    body: { classList: { add() {}, remove() {} }, appendChild(value) { container = value; } },
  };
  const createRoot = (target) => {
    const node = {};
    return {
      render(content) { node.content = content; target.children.push(node); log.push("dev:render"); },
      unmount() { target.removeChild(node); log.push("dev:unmount"); },
    };
  };
  const createElement = (component, props, ...children) => ({ component, props, children });
  const code = compile(globals + "\n" + opener, { define: { "import.meta.env.DEV": String(dev) } });
  const { open, close } = new Function(
    "createOverlayLifecycle", "requestAnimationFrame", "document", "useCallback", "loadWidget",
    "trackAnalyticsEvent", "trackClientError", "createRoot", "createElement", "OverlayScopeProvider", "loadDevModule", "window",
    code + "\nreturn { open: openOverlayModule, close: hideOverlay };",
  )(
    createOverlayLifecycle, callback => frames.push(callback), document, callback => callback,
    (src, globalName, options) => { const request = deferred(); requests.push({ ...request, src, globalName, options }); return request.promise; },
    (name, data) => events.push({ name, data }), (...args) => errors.push(args), createRoot, createElement, "scope",
    path => { const request = deferred(); imports.push({ ...request, path }); return request.promise; }, {},
  );
  const widgets = (name, behavior = {}) => {
    let node;
    const widget = {
      mounts: [], unmounts: 0,
      mount(options) {
        widget.unmount();
        node = {};
        container.children.push(node);
        widget.mounts.push(options);
        log.push(name + ":mount");
        behavior.mount?.(options);
      },
      unmount() {
        if (!node) return;
        container.removeChild(node);
        node = undefined;
        widget.unmounts++;
        log.push(name + ":unmount");
      },
    };
    return widget;
  };
  return { open, close, frames, log, events, errors, requests, imports, widgets,
    container: () => container,
    flush: () => { while (frames.length) frames.shift()(); },
  };
}

test("cached tournament reopen unmounts before replacing React-owned DOM", async () => {
  const h = harness(), widget = h.widgets("tournaments");
  let opening = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments", { tournamentId: "first" });
  h.requests[0].resolve(widget); await opening;
  h.log.length = 0;
  opening = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments", { tournamentId: "second" });
  assert.equal(h.log[0], "tournaments:unmount");
  assert.ok(h.log.indexOf("tournaments:unmount") < h.log.indexOf("loading"));
  h.requests[1].resolve(widget); await opening;
  assert.equal(widget.unmounts, 1);
  assert.equal(widget.mounts.at(-1).data.tournamentId, "second");
  assert.equal(h.errors.length, 0);
});

test("out-of-order loads only mount the latest tournament and preserve its target", async () => {
  const h = harness(), widget = h.widgets("latest");
  const a = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments", { tournamentId: "a" });
  const b = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments", { tournamentId: "b" });
  h.requests[1].resolve(widget); await b;
  h.requests[0].resolve(widget); await a;
  assert.equal(widget.mounts.length, 1);
  assert.equal(widget.mounts[0].data.tournamentId, "b");
  assert.equal(h.events.filter(event => event.name === "module_opened").length, 1);
});

test("late load failures cannot replace another module or emit its failure", async () => {
  const h = harness(), widget = h.widgets("latest");
  const a = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments");
  const b = h.open("levels-info", "/levels.js", "LKWidgetLevelsInfo");
  h.requests[1].resolve(widget); await b;
  const before = h.container().children.slice();
  h.requests[0].reject(new Error("stale failure")); await a;
  assert.deepEqual(h.container().children, before);
  assert.equal(h.errors.length, 0);
});

test("close while loading invalidates the request even before a root exists", async () => {
  const h = harness(), widget = h.widgets("late");
  const opening = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments");
  h.close(); h.flush();
  h.requests[0].resolve(widget); await opening;
  assert.equal(widget.mounts.length, 0);
  assert.equal(h.container().children.length, 0);
});

test("old close callbacks and deferred cleanup cannot clear a newly reopened root", async () => {
  const h = harness(), first = h.widgets("first"), second = h.widgets("second");
  let opening = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments");
  h.requests[0].resolve(first); await opening;
  const oldClose = first.mounts[0].onClose;
  oldClose(); oldClose();
  opening = h.open("games", "/games.js", "LKWidgetGames");
  assert.equal(first.unmounts, 1);
  h.requests[1].resolve(second); await opening;
  const before = h.container().children.slice();
  oldClose(); h.flush();
  assert.deepEqual(h.container().children, before);
  assert.equal(first.unmounts, 1);
  assert.equal(second.unmounts, 0);
  assert.equal(h.requests[1].options.forceReload, true);
});

test("mount failure disposes its partial root before showing an inert error", async () => {
  const h = harness(), widget = h.widgets("partial", { mount() { throw new Error("<b>synthetic failure</b>"); } });
  const opening = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments");
  h.requests[0].resolve(widget); await opening;
  assert.equal(widget.unmounts, 1);
  assert.ok(h.log.indexOf("partial:unmount") < h.log.indexOf("replace"));
  assert.equal(h.errors.length, 1);
  assert.equal(h.container().children[0].children[0].value, "<b>synthetic failure</b>");
});

test("a synchronous close during mount is not reported as an opened module", async () => {
  const h = harness(), widget = h.widgets("closing", { mount(options) { options.onClose(); } });
  const opening = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments");
  h.requests[0].resolve(widget); await opening; h.flush();
  assert.equal(widget.unmounts, 1);
  assert.equal(h.events.filter(event => event.name === "module_opened").length, 0);
});

test("dev imports resolving out of order never create or render a stale root", async () => {
  const h = harness(true);
  const a = h.open("tournaments", undefined, undefined, { tournamentId: "a" });
  const b = h.open("tournaments", undefined, undefined, { tournamentId: "b" });
  h.imports[1].resolve({ default: "tournaments" }); await b;
  h.imports[0].resolve({ default: "tournaments" }); await a;
  assert.equal(h.log.filter(value => value === "dev:render").length, 1);
  assert.equal(h.container().children[0].content.children[0].props.initialOpenTournamentId, "b");
  h.close(); h.flush();
  assert.equal(h.log.filter(value => value === "dev:unmount").length, 1);
});

test("a burst of pending opens mounts once; repeated cached opens and deferred closes stay safe", async () => {
  const h = harness(), widget = h.widgets("burst");
  const burst = Array.from({ length: 20 }, (_, index) => h.open(
    "tournaments", "/tournaments.js", "LKWidgetTournaments", { tournamentId: String(index) },
  ));
  for (const request of h.requests.toReversed()) request.resolve(widget);
  await Promise.all(burst);
  assert.equal(widget.mounts.length, 1);
  assert.equal(widget.mounts[0].data.tournamentId, "19");
  for (let index = 0; index < 20; index++) {
    const opening = h.open("tournaments", "/tournaments.js", "LKWidgetTournaments");
    h.requests.at(-1).resolve(widget); await opening;
    widget.mounts.at(-1).onClose();
  }
  h.flush();
  assert.equal(widget.unmounts, 21);
  assert.equal(h.errors.length, 0);
  assert.equal(h.container().children.length, 0);
});

test("a rejected stale dev import leaves the current local root unchanged", async () => {
  const h = harness(true);
  const a = h.open("tournaments");
  const b = h.open("games");
  h.imports[1].resolve({ default: "games" }); await b;
  const before = h.container().children.slice();
  h.imports[0].reject(new Error("stale dev failure")); await a;
  assert.deepEqual(h.container().children, before);
  assert.equal(h.errors.length, 0);
});
