/* global document, HTMLFormElement, location, window, XMLHttpRequest */
import { normalizedPilotQuery, pilotLocalStorage } from "./isolation.mjs";

import { readPilotTarget } from "./policy.mjs";

const pilotPath = "/lk-test";

function installPilotTransport(apiUrl, nativeFetch) {
  function forward(input, method) {
    const url = readPilotTarget(new URL(input, location.href).href, method);
    if (!url) return null;
    return url;
  }

  window.fetch = async (input, init) => {
    const request = new Request(
      typeof input === "string" ? new URL(input, location.href) : input,
      init,
    );
    const target = forward(request.url, request.method);
    if (!target) return new Response(JSON.stringify({ code: "LK_PILOT_REQUEST_BLOCKED" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    return nativeFetch(apiUrl, {
      method: request.method,
      headers: {
        ...Object.fromEntries(["accept", "authorization", "content-type"].flatMap((name) =>
          request.headers.has(name) ? [[name, request.headers.get(name)]] : [],
        )),
        "x-lk-pilot-target": target.href,
      },
      body: request.body ? await request.arrayBuffer() : undefined,
      signal: request.signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  };

  const requestOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, async = true) {
    const upper = String(method).toUpperCase();
    const target = forward(url, upper);
    if (!target || upper !== "GET" || !async) throw new DOMException("Pilot request blocked", "SecurityError");
    requestOpen.call(this, upper, apiUrl.href, true);
    this.setRequestHeader("x-lk-pilot-target", target.href);
  };
  navigator.sendBeacon = () => false;
  window.WebSocket = class {
    constructor() { throw new DOMException("Pilot sockets are disabled", "SecurityError"); }
  };
  window.EventSource = class {
    constructor() { throw new DOMException("Pilot event streams are disabled", "SecurityError"); }
  };
}

function installPilotNavigation() {
  const nativeOpen = window.open.bind(window);
  window.open = (value, target, features) => {
    if (!value) return null;
    const href = new URL(value, location.href);
    return href.origin === location.origin && href.pathname === pilotPath
      ? nativeOpen(href.href, target, features)
      : null;
  };
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  HTMLFormElement.prototype.submit = () => undefined;
  HTMLFormElement.prototype.requestSubmit = () => undefined;
}

function loadAsset(assetBase, file, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(file, assetBase).href;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

async function start() {
  const root = document.getElementById("root");
  if (!root || location.pathname !== pilotPath) throw new Error("Invalid pilot page");
  const assetBase = new URL("./", import.meta.url);
  const version = assetBase.pathname.match(/^\/lk-pilot\/([a-f0-9]{24})\/$/)?.[1];
  if (!version) throw new Error("Invalid pilot asset directory");

  const nativeFetch = window.fetch.bind(window);
  const response = await nativeFetch(new URL("release.json", assetBase), {
    credentials: "omit", cache: "no-store", redirect: "error",
  });
  if (!response.ok) throw new Error("Pilot manifest is unavailable");
  const manifest = await response.json();
  if (manifest?.channel !== "lk1-pilot" || manifest.version !== version) {
    throw new Error("Invalid pilot manifest");
  }

  const file = "booking.js";
  const integrity = manifest.assets?.[file];
  if (!/^sha384-[A-Za-z0-9+/]{64}$/.test(integrity)) throw new Error("Missing pilot artifact integrity");

  const query = normalizedPilotQuery(location.search);
  const canonical = pilotPath + (query ? "?" + query : "");
  if (location.pathname + location.search + location.hash !== canonical) {
    window.history.replaceState(null, "", canonical);
  }
  Object.defineProperty(window, "localStorage", { value: pilotLocalStorage(window.localStorage) });
  installPilotTransport(new URL("/lk-pilot-api", assetBase), nativeFetch);
  installPilotNavigation();
  const base = assetBase.href.replace(/\/$/, "");
  Object.defineProperty(window, "__LK_PILOT_ASSET_BASE__", { value: base });
  window.__LK_ACTIVE_BASE_URL__ = base;
  window.__LK_BASE_URLS__ = [base];
  window.__LK_RELEASE_VERSION__ = manifest.version;

  await loadAsset(assetBase, file, integrity);
}

start().catch(() => {
  const root = document.getElementById("root");
  if (root) root.textContent = "Не удалось загрузить тестовый ЛК.";
});
