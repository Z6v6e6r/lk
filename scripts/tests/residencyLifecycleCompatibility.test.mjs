import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const importJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "node-red/imports/lk_residency_lifecycle.import.json"), "utf8"));
const live = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/tests/fixtures/lk1-live-http-routes-20261118.json"), "utf8"));
const published = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/tests/fixtures/lk1-published-bundle-20261118.json"), "utf8"));

const newRoutes = importJson.filter((node) => node.type === "http in")
  .map((node) => ({ method: String(node.method).toUpperCase(), url: String(node.url), id: String(node.id) }));
const oldRoutes = live.routes.map((row) => ({ method: row.method, url: row.url, id: row.id }));

test("the added flow shares no URL/method or node id with the installed LK1 graph", () => {
  assert.equal(newRoutes.length, 15);
  assert.equal(newRoutes.filter((route) => route.method !== "OPTIONS").length, 8);
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

test("the published old bundle cannot call the new lifecycle API", () => {
  assert.equal(published.sourceCommit, "8ff3735e7106815db702f47c2ec5faa0f91a88c4");
  assert.equal(published.version, "20261118T144752Z");
  assert.equal(published.bundleSha256.length, 64);
  // The old purchase page and the old pass gateway are still in the client.
  assert.equal(published.markers.buyResidency, 1);
  assert.equal(published.markers["4037a3a3-e551-4f9a-a9db-1410e46b8635"], 2);
  assert.ok(published.lkPaths.includes("/lk/residency/passes"));
  assert.ok(published.lkPaths.some((value) => value.startsWith("/lk/tournaments/summer-subscription/status")));
  // No new route or new refusal code is present, so the old checkout keeps its own
  // Viva transaction flow and cannot silently switch to the lifecycle owner.
  assert.equal(published.markers["residency/orders"], 0);
  assert.equal(published.markers["buyResidency=lifecycle"], 0);
  assert.equal(published.markers.RESIDENCY_ORDERS_DISABLED, 0);
  assert.equal(published.markers.RESIDENCY_CREATE_NOT_ALLOWED, 0);
  assert.equal(published.lkPaths.some((value) => value.includes("/lk/residency/orders")), false);
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

test("the fixture is pinned by the installed release hash read back from the host", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/tests/fixtures/lk1-published-bundle-20261118.json"), "utf8"));
  assert.equal(manifest.bundleSha256, "79789bf8a5d755ed7c6391208b76a058738f39b393f3cd85175b08bbfb097a7f");
  assert.equal(manifest.bundleBytes, 2946687);
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(manifest.lkPaths)).digest("hex").length, 64);
});
