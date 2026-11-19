#!/usr/bin/env node
// Read-only residency discount preview. It calls the existing advisory endpoint and never
// creates a booking, game, order or payment. The bearer is read from the environment and is
// never printed.
//
//   LK_PILOT_BEARER='<token>' LK_PREVIEW_TARGET='{"..."}' \
//   LK_PREVIEW_SUBSCRIPTION_IDS='["..."]' node discount-preview.mjs
//
// LK_PREVIEW_TARGET is the same target object the game/training price preview uses.
const base = String(process.env.LK_PREVIEW_BASE || "https://padlhub.su").replace(/\/+$/, "");
const token = String(process.env.LK_PILOT_BEARER || "");
const targetRaw = String(process.env.LK_PREVIEW_TARGET || "");
const idsRaw = String(process.env.LK_PREVIEW_SUBSCRIPTION_IDS || "[]");
if (!token) { console.error("LK_PILOT_BEARER is required"); process.exit(2); }
let target;
let subscriptionIds;
try { target = JSON.parse(targetRaw); } catch { console.error("LK_PREVIEW_TARGET must be JSON"); process.exit(2); }
try { subscriptionIds = JSON.parse(idsRaw); } catch { console.error("LK_PREVIEW_SUBSCRIPTION_IDS must be a JSON array"); process.exit(2); }
if (!target || typeof target !== "object" || Array.isArray(target) || !Array.isArray(subscriptionIds)) {
  console.error("target must be an object and subscriptionIds an array");
  process.exit(2);
}
const response = await fetch(base + "/lk/subscriptions/game-price-preview", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  body: JSON.stringify({ target, subscriptionIds }),
});
const text = await response.text();
let body;
try { body = JSON.parse(text); } catch { body = null; }
console.log(JSON.stringify({ status: response.status, ok: response.status === 200 && Array.isArray(body?.quotes),
  quotes: Array.isArray(body?.quotes) ? body.quotes : null, body: body ?? text.slice(0, 400) }, null, 1));
if (response.status !== 200 || !Array.isArray(body?.quotes) || body.quotes.length === 0) process.exit(1);
