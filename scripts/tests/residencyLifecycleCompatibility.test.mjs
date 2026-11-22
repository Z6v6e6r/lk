import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const importJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "node-red/imports/lk_residency_lifecycle.import.json"), "utf8"));
const live = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/tests/fixtures/lk1-live-http-routes-20261118.json"), "utf8"));
const published = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/tests/fixtures/lk1-published-bundle-20261118T164240Z.json"), "utf8"));
const historical = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/tests/fixtures/lk1-published-bundle-20261118.json"), "utf8"));

const newRoutes = importJson.filter((node) => node.type === "http in")
  .map((node) => ({ method: String(node.method).toUpperCase(), url: String(node.url), id: String(node.id) }));
const oldRoutes = live.routes.map((row) => ({ method: row.method, url: row.url, id: row.id }));

test("the added flow shares no URL/method or node id with the installed LK1 graph", () => {
  assert.equal(newRoutes.length, 17);
  assert.equal(newRoutes.filter((route) => route.method !== "OPTIONS").length, 9);
  const oldKeys = new Set(oldRoutes.map((row) => row.method + " " + row.url));
  for (const route of newRoutes) {
    assert.equal(oldKeys.has(route.method + " " + route.url), false, "duplicate route " + route.method + " " + route.url);
    assert.match(route.url, /^\/lk\/residency\//);
  }
  const oldIds = new Set(oldRoutes.map((row) => row.id));
  for (const node of importJson) {
    assert.equal(oldIds.has(node.id), false, "node id collision " + node.id);
  }
  // The existing residency pass routes stay untouched: the new API adds a different
  // path namespace, so an old client that calls /lk/residency/passes is not rerouted.
  assert.equal(oldRoutes.some((row) => row.url === "/lk/residency/passes"), false);
  assert.equal(newRoutes.some((row) => row.url === "/lk/residency/passes"), false);
});

test("the current published bundle cannot call the new lifecycle API", () => {
  assert.equal(published.sourceCommit, "27ea6a8c1665789786b8a6c6fc9c657dc48483ed");
  assert.equal(published.version, "20261118T164240Z");
  assert.equal(published.bundleSha256.length, 64);
  // The residency purchase page and the old pass gateway are still in the client.
  assert.equal(published.markers.buyResidency, 1);
  assert.equal(published.markers.phCheckoutReturn, 3);
  assert.equal(published.markers["4037a3a3-e551-4f9a-a9db-1410e46b8635"], 2);
  assert.ok(published.lkPaths.includes("/lk/residency/passes"));
  assert.ok(published.lkPaths.some((value) => value.startsWith("/lk/tournaments/summer-subscription/status")));
  // No new route, lifecycle return marker or refusal code is present, so the
  // current checkout keeps its own Viva transaction flow and cannot silently
  // switch to the lifecycle owner.
  assert.equal(published.markers["residency/orders"], 0);
  assert.equal(published.markers["buyResidency=lifecycle"], 0);
  assert.equal(published.markers.phResidencyLifecycleReturn, 0);
  assert.equal(published.markers.RESIDENCY_ORDERS_DISABLED, 0);
  assert.equal(published.markers.RESIDENCY_CREATE_NOT_ALLOWED, 0);
  assert.equal(published.lkPaths.some((value) => value.includes("/lk/residency/orders")), false);
  // The purchase is a direct browser POST to the VivaCRM base (Ea), never to
  // the pilot lifecycle namespace on padlhub.su.
  assert.ok(published.vivaPaths.includes("${Ea}/end-user/api/v1/${gn}/transactions"));
  assert.equal(published.vivaPaths.some((value) => value.includes("residency/orders")), false);
});

test("the new import does not carry credentials, redirects or a personal allowlist", () => {
  const serialized = JSON.stringify(importJson);
  for (const forbidden of ["Bearer ", "CUP_INTEGRATION_TOKEN", "PILOT_USERS", "mongodb://", "https://"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  // The allowlist is environment-only and is read by the custom node, never by the flow.
  const nodeSource = fs.readFileSync(path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api/residency-lifecycle-node.cjs"), "utf8");
  assert.match(nodeSource, /LK_RESIDENCY_LIFECYCLE_PILOT_USERS/);
  assert.match(nodeSource, /LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED/);
  assert.match(nodeSource, /RESIDENCY_CREATE_NOT_ALLOWED/);
});

test("the fixture pins the currently published release artifact", () => {
  assert.equal(published.releaseUrl, "https://padlhub.su/lk/release.json");
  assert.equal(published.bundleUrl, "https://padlhub.su/lk/bundle.js");
  assert.match(published.retrievedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(published.bundleSha256, "fce60c89044f95ef7ec9faf1d53267dfce87fcc996efa00dbacee87ab50485be");
  assert.equal(published.bundleBytes, 2946728);
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(published.lkPaths)).digest("hex").length, 64);
  // The earlier artifact stays as the historical record: the published
  // artifact changed after the first pilot evidence was captured.
  assert.equal(historical.version, "20261118T144752Z");
  assert.equal(historical.sourceCommit, "8ff3735e7106815db702f47c2ec5faa0f91a88c4");
  assert.equal(historical.bundleSha256, "79789bf8a5d755ed7c6391208b76a058738f39b393f3cd85175b08bbfb097a7f");
  assert.equal(historical.bundleBytes, 2946687);
  assert.equal(published.previousPinned.version, historical.version);
  assert.equal(published.previousPinned.bundleSha256, historical.bundleSha256);
  assert.notEqual(published.bundleSha256, historical.bundleSha256);
  assert.notEqual(published.bundleBytes, historical.bundleBytes);
});
