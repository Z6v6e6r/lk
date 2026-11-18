import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const PLAYWRIGHT_ROOT = String(process.env.LK_PLAYWRIGHT_ROOT || "").trim();
if (!PLAYWRIGHT_ROOT) throw new Error("LK_PLAYWRIGHT_ROOT is required (a package with Playwright and Chromium)");
const require = createRequire(PLAYWRIGHT_ROOT + "/package.json");
const { chromium } = require("playwright");

const FIXTURE = "https://127.0.0.1:9443";
const OLD = "https://127.0.0.1:8444";
const NEW = "https://127.0.0.1:8443";
const WORK = process.env.LK_PILOT_WORK || "/tmp/lk1-pilot-run";
const COMPOSE = "docker compose -f " + WORK + "/compose.yaml";
const MONGO_CONTAINER = process.env.LK_PILOT_MONGO_CONTAINER || "lk1-pilot-mongo";
const mongoEval = (script) => execSync("docker exec " + MONGO_CONTAINER + " mongosh lk_residency_pilot --quiet --eval '" + script + "'").toString().trim();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(role) {
  return b64({ alg: "none", typ: "JWT" }) + "." + b64({
    sub: role === "ordinary" ? "ordinary.user.0001" : "pilot.user.0001",
    phone: role === "ordinary" ? "+15550000001" : "+15550000000",
    azp: "widget", tenant_key: "iSkq6G", role, exp: Math.floor(Date.now() / 1000) + 86400,
  }) + ".";
}
const storage = (role) => JSON.stringify({ token: token(role), expiresAt: Date.now() + 86400000 });

const result = { scenarios: [], fixture: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeout = 20000, interval = 200) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("timeout");
    await sleep(interval);
  }
}
const state = async () => (await fetch(FIXTURE + "/_control/state")).json();
const control = (path, body) => fetch(FIXTURE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
function reset() {
  mongoEval("db.lk_residency_lifecycle_orders.deleteMany({})");
  return control("/_control/reset");
}
async function gatewayReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(NEW + "/lk/residency/catalog", { method: "OPTIONS" });
      if (response.status === 204) return true;
    } catch { /* the gateway is still starting */ }
    await sleep(500);
  }
  throw new Error("gateway not ready");
}
function soleOrderId() {
  return mongoEval("const d=db.lk_residency_lifecycle_orders.findOne({}); print(d?d.orderId:String())");
}
function compose(args, extraFile) {
  execSync(COMPOSE + (extraFile ? " -f " + extraFile : "") + " " + args, { stdio: "pipe" });
}

const browser = await chromium.launch({ headless: true });
const contexts = [];
async function newDevice(role = "pilot") {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 430, height: 950 } });
  await context.addInitScript((value) => {
    try { globalThis.localStorage.setItem("padlhub_auth_token_v1", value); } catch { /* storage unavailable */ }
  }, storage(role));
  contexts.push(context);
  const page = await context.newPage();
  const requests = [];
  const responses = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  page.on("response", async (response) => {
    const request = response.request();
    if (request.url().includes("/lk/residency/orders") && request.method() === "POST") {
      responses.push({ status: response.status(), url: request.url(), body: await response.text().catch(() => "") });
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const u = new URL(request.url());
    if (u.hostname === "api.vivacrm.ru") return route.continue({ url: FIXTURE + "/viva" + u.pathname + u.search });
    if (u.hostname === "kc.vivacrm.ru") return route.continue({ url: FIXTURE + "/kc" + u.pathname + u.search });
    if (u.hostname === "bank.fixture.invalid") return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>BANK FIXTURE</body></html>" });
    if (u.hostname === "127.0.0.1") return route.continue();
    return route.fulfill({ status: 204, body: "" });
  });
  return { page, requests, responses };
}
const createPosts = (device) => device.responses.filter((row) => { try { return new URL(row.url).pathname === "/lk/residency/orders"; } catch { return false; } });
const text = async (page) => (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();

async function openOld(device) {
  await device.page.goto(OLD + "/lk_new?buyResidency=1", { waitUntil: "domcontentloaded" });
  await device.page.locator('[data-ph-buy="residency"]').first().waitFor({ state: "visible", timeout: 30000 });
}
async function buyOld(device) {
  await openOld(device);
  await device.page.locator('[data-ph-buy="residency"]').first().click();
  await waitFor(async () => (await state()).txs.some((tx) => tx.source === "old"));
}
async function openNew(device, suffix = "?buyResidency=lifecycle") {
  await device.page.goto(NEW + "/lk_new" + suffix, { waitUntil: "domcontentloaded" });
}

// ---------- A. old purchase first, then the new page on another device ----------
await reset();
{
  const oldDevice = await newDevice();
  await buyOld(oldDevice);
  const oldState = await state();
  const newPilot = await newDevice();
  await openNew(newPilot);
  await sleep(2500);
  const body = await text(newPilot.page);
  const posts = createPosts(newPilot);
  const listed = await (await fetch(NEW + "/lk/residency/orders?state=unresolved", { headers: { Authorization: "Bearer " + token("pilot") } })).json();
  result.scenarios.push({
    id: "A_old_then_new",
    old_txs: oldState.txs.map((tx) => ({ source: tx.source, status: tx.status })),
    new_page_text: body.slice(0, 300),
    new_create_posts: posts.length,
    server_external_check: listed.externalCheck,
    old_page_direct_posts: oldDevice.requests.filter((row) => row.url.includes("/end-user/api/v1/iSkq6G/transactions")).map((row) => row.method + " " + row.url.replace(/^https:\/\/[^/]+/, "")),
    pass: posts.length === 0 && body.includes("Сервер обнаружил покупку резидентства") && listed.externalCheck?.requiresReview === true,
  });
}

// ---------- B. new purchase first, then the old published checkout ----------
await reset();
{
  const newPilot = await newDevice();
  await openNew(newPilot);
  await newPilot.page.getByRole("button", { name: /Стать резидентом/ }).click();
  await waitFor(async () => createPosts(newPilot).length > 0);
  const orderId = soleOrderId();
  const oldDevice = await newDevice();
  await buyOld(oldDevice);
  const before = await state();
  const oldTx = before.txs.find((tx) => tx.source === "old");
  await control("/_control/pay", { transactionId: oldTx.id });
  await openNew(newPilot, "?phResidencyLifecycleReturn=1");
  await sleep(3500);
  const body = await text(newPilot.page);
  const order = await (await fetch(NEW + "/lk/residency/orders/" + orderId, { headers: { Authorization: "Bearer " + token("pilot") } })).json();
  result.scenarios.push({
    id: "B_new_then_old",
    order_id: orderId,
    new_create_posts: createPosts(newPilot).length,
    old_tx_source: oldTx.source,
    final_state: order.state,
    activation_error: order.activation?.lastErrorCode ?? null,
    new_page_text: body.slice(0, 300),
    pass: order.state === "PAID_REQUIRES_REVIEW" && order.activation?.lastErrorCode === "EXTERNAL_PAYMENT_DETECTED",
  });
}

// ---------- C. two devices create at the same time ----------
await reset();
{
  const left = await newDevice();
  const right = await newDevice();
  await openNew(left);
  await openNew(right);
  await Promise.all([
    left.page.getByRole("button", { name: /Стать резидентом/ }).click(),
    right.page.getByRole("button", { name: /Стать резидентом/ }).click(),
  ]);
  await sleep(3500);
  const statuses = [...createPosts(left), ...createPosts(right)].map((row) => row.status);
  const fixture = await state();
  result.scenarios.push({
    id: "C_two_devices",
    create_statuses: statuses,
    orders: mongoEval("db.lk_residency_lifecycle_orders.countDocuments({})"),
    new_txs: fixture.txs.filter((tx) => tx.source === "new").length,
    pass: statuses.filter((status) => status === 200).length === 1 && fixture.txs.filter((tx) => tx.source === "new").length === 1,
  });
}

// ---------- D. stop CREATE, read/recover, old frontend, restart, complete ----------
await reset();
{
  const device = await newDevice();
  await openNew(device);
  await device.page.getByRole("button", { name: /Стать резидентом/ }).click();
  await waitFor(async () => createPosts(device).length > 0);
  const orderId = soleOrderId();
  const tx = (await state()).txs.find((row) => row.source === "new");

  compose("up -d --force-recreate nodered", WORK + "/compose.stopped.yaml");
  await gatewayReady();
  const stoppedCreate = await fetch(NEW + "/lk/residency/orders", {
    method: "POST", headers: { Authorization: "Bearer " + token("pilot"), "Content-Type": "application/json", "Idempotency-Key": "stopped-create-key-0001" },
    body: JSON.stringify({ mode: "NEW", expectedTotalMinor: 79000, expectedProductId: "4037a3a3-e551-4f9a-a9db-1410e46b8635" }),
  });
  const stoppedBody = await stoppedCreate.text();
  const readAfterStop = await (await fetch(NEW + "/lk/residency/orders?state=unresolved", { headers: { Authorization: "Bearer " + token("pilot") } })).json();
  const rollbackDevice = await newDevice();
  await openOld(rollbackDevice);
  const rollbackText = await text(rollbackDevice.page);

  compose("up -d --force-recreate nodered");
  await gatewayReady();
  await control("/_control/pay", { transactionId: tx.id });
  const returnDevice = await newDevice();
  await openNew(returnDevice, "?phResidencyLifecycleReturn=1");
  await sleep(3500);
  const order = await (await fetch(NEW + "/lk/residency/orders/" + orderId, { headers: { Authorization: "Bearer " + token("pilot") } })).json();
  const finalFixture = await state();
  result.scenarios.push({
    id: "D_stop_and_recover",
    stopped_create_status: stoppedCreate.status,
    stopped_code: JSON.parse(stoppedBody).code,
    orders_visible_after_stop: readAfterStop.count,
    old_frontend_rollback_text: rollbackText.slice(0, 120),
    final_state: order.state,
    new_txs_total: finalFixture.txs.filter((row) => row.source === "new").length,
    pass: stoppedCreate.status === 503 && JSON.parse(stoppedBody).code === "RESIDENCY_ORDERS_DISABLED"
      && readAfterStop.count === 1 && order.state === "ACTIVE"
      && finalFixture.txs.filter((row) => row.source === "new").length === 1,
  });
}

// ---------- E. ordinary account: new create denied, old scenario preserved ----------
await reset();
{
  const ordinary = await newDevice("ordinary");
  await openNew(ordinary);
  await sleep(1500);
  await ordinary.page.getByRole("button", { name: /Стать резидентом/ }).click();
  await waitFor(async () => createPosts(ordinary).length > 0);
  await sleep(800);
  const body = await text(ordinary.page);
  const posts = createPosts(ordinary);
  const orders = mongoEval("db.lk_residency_lifecycle_orders.countDocuments({})");
  const oldDevice = await newDevice("ordinary");
  await buyOld(oldDevice);
  const fixture = await state();
  result.scenarios.push({
    id: "E_ordinary_account",
    new_page_text: body.slice(0, 240),
    new_create_statuses: posts.map((row) => row.status),
    orders_after_denied_create: orders,
    old_tx_created: fixture.txs.filter((tx) => tx.source === "old").length,
    pass: posts.length === 1 && posts[0].status === 403 && orders === "0"
      && body.includes("не включён для этого аккаунта")
      && fixture.txs.filter((tx) => tx.source === "old").length === 1,
  });
}

result.fixture = await state();
console.log(JSON.stringify({ scenarios: result.scenarios, txSources: result.fixture.txs.map((tx) => tx.source) }, null, 1));
await browser.close();