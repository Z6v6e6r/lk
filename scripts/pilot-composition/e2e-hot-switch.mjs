import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { LK_PILOT_WORK, LK_PLAYWRIGHT_ROOT } = process.env;
if (!LK_PILOT_WORK || !LK_PLAYWRIGHT_ROOT) throw new Error("Set LK_PILOT_WORK and LK_PLAYWRIGHT_ROOT");
const require = createRequire(join(LK_PLAYWRIGHT_ROOT, "package.json"));
const { chromium } = require("playwright");
const origin = "https://127.0.0.1:8443";
const fixture = "https://127.0.0.1:9443";
const pilotUrl = origin + "/lk_new?buyResidency=lifecycle&authMode=viva";
const cabinetUrl = origin + "/lk_new?authMode=viva";
const container = "lk1-pilot-nodered";
const controlFile = join(LK_PILOT_WORK, "control/mode");

function runtime() {
  const containerState = execFileSync("docker", ["inspect", "--format",
    "{{.Id}} {{.State.StartedAt}} {{.RestartCount}}", container], { encoding: "utf8" }).trim();
  const processes = execFileSync("docker", ["top", container, "-eo", "pid,args"], { encoding: "utf8" });
  const pid = processes.match(/^\s*(\d+)\s+node-red(?:\s|$)/m)?.[1];
  assert.ok(pid, "The Node-RED process must be running");
  return { containerState, pid };
}

async function setMode(mode) {
  await writeFile(controlFile + ".next", mode + "\n", { mode: 0o644 });
  await rename(controlFile + ".next", controlFile);
}

function session(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = encode({ alg: "none", typ: "JWT" }) + "." + encode({
    sub: role + ".user.0001", phone: "+15550000000", azp: "widget", tenant_key: "iSkq6G",
    role, exp: Math.floor(Date.now() / 1000) + 86400,
  }) + ".";
  return { token, expiresAt: Date.now() + 86400000 };
}

async function api(path, sessionToken, options = {}) {
  return fetch(origin + "/lk/residency/" + path, {
    ...options,
    headers: { ...options.headers, ...(sessionToken && { Authorization: "Bearer " + sessionToken }) },
  });
}

async function assertCreateRefused(sessionToken) {
  const response = await api("orders", sessionToken, { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "fixture-hot-switch-check" },
    body: JSON.stringify({ mode: "NEW", expectedTotalMinor: 79000 }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "RESIDENCY_ORDERS_DISABLED");
}

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const writes = [];
async function newTab(role) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript((value) => localStorage.setItem("padlhub_auth_token_v1", value), JSON.stringify(session(role)));
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && (/transactions|\/lk\/residency\/orders/.test(url.pathname))) {
      writes.push(url.pathname);
      return route.abort();
    }
    if (url.origin === origin) return route.continue();
    if (url.hostname === "api.vivacrm.ru") return route.continue({ url: fixture + "/viva" + url.pathname + url.search });
    if (url.hostname === "kc.vivacrm.ru") return route.continue({ url: fixture + "/kc" + url.pathname + url.search });
    return route.fulfill({ status: 204, body: "" });
  });
  return context.newPage();
}

try {
  const before = runtime();
  const pilotSession = session("pilot");
  await setMode("preview");

  const access = await api("pilot-access", pilotSession.token);
  assert.equal(access.status, 200);
  assert.equal(access.headers.get("cache-control"), "no-store");
  assert.deepEqual(await access.json(), { schemaVersion: 1, canCreate: false });
  assert.equal((await api("pilot-access")).status, 401);
  assert.equal((await api("pilot-access", session("ordinary").token)).status, 403);
  await assertCreateRefused(pilotSession.token);

  const ordinary = await newTab("ordinary");
  await ordinary.goto(pilotUrl);
  await ordinary.waitForURL(cabinetUrl);
  assert.equal(await ordinary.locator(".ph-residency-pilot").count(), 0);
  await ordinary.goto(origin + "/lk_new?buyResidency=1");
  await ordinary.locator('[data-ph-buy="residency"]').waitFor({ state: "visible" });

  const pilot = await newTab("pilot");
  await pilot.goto(pilotUrl);
  await pilot.getByText("Предпросмотр. Оформление и оплата отключены.").waitFor();
  assert.equal(await pilot.getByText("790 ₽", { exact: true }).isVisible(), true);
  assert.equal(await pilot.locator(".ph-residency-cta").count(), 0);

  const observedOff = pilot.waitForResponse((response) => response.url().endsWith("/lk/residency/pilot-access")
    && response.status() === 503);
  const startedAt = performance.now();
  await setMode("off");
  await observedOff;
  await pilot.waitForURL(cabinetUrl);
  const fallbackMs = Math.round(performance.now() - startedAt);
  assert.equal(await pilot.locator(".ph-residency-pilot").count(), 0);
  assert.equal(await ordinary.locator('[data-ph-buy="residency"]').isVisible(), true);

  const closed = await api("pilot-access", pilotSession.token);
  assert.equal(closed.status, 503);
  assert.equal((await closed.json()).code, "RESIDENCY_PILOT_CLOSED");
  await assertCreateRefused(pilotSession.token);
  const unresolved = await api("orders?state=unresolved", pilotSession.token);
  assert.equal(unresolved.status, 200);
  assert.equal((await unresolved.json()).count, 0);

  const returning = await newTab("pilot");
  await returning.goto(origin + "/lk_new?phResidencyLifecycleReturn=1&authMode=viva");
  await returning.getByText(/Заказ не найден/).waitFor();
  assert.equal(new URL(returning.url()).searchParams.get("phResidencyLifecycleReturn"), "1");

  const freshTab = await newTab("pilot");
  await freshTab.goto(pilotUrl);
  await freshTab.waitForURL(cabinetUrl);
  await setMode("preview");
  await freshTab.goto(pilotUrl);
  await freshTab.getByText("Предпросмотр. Оформление и оплата отключены.").waitFor();
  assert.deepEqual(runtime(), before);
  assert.deepEqual(writes, []);
  const state = await (await fetch(fixture + "/_control/state")).json();
  assert.deepEqual(state.txs, []);
  assert.deepEqual(state.subs, []);
  console.log(JSON.stringify({ fallbackMs, nodeRedProcessUnchanged: true, ordinaryAccountDenied: true,
    legacyPageAvailable: true, bankReturnAvailable: true, browserCreateRequests: writes.length,
    providerTransactions: state.txs.length, previewRestored: true }));
} finally {
  await setMode("off");
  await browser.close();
}
