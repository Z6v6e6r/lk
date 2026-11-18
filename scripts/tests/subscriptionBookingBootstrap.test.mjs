import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerSettings } from "../diagnostics/subscription-booking-bootstrap.mjs";
import { SUBSCRIPTION_BOOKING_SCOPE } from "../diagnostics/subscription-booking-scope.mjs";

function setup() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "booking-bootstrap-")); fs.chmodSync(root, 0o700);
  return { root, config: { receiptPath: path.join(root, "ready.json"), generation: "a".repeat(32), bundleSha256: "b".repeat(64), release: "c".repeat(40) } };
}
test("registration preserves settings/middleware and startup mock events never reach real sink", () => {
  const { root, config } = setup(), events = [], middleware = () => {}, existing = { retained: true };
  const settings = { httpNodeMiddleware: middleware, adminAuth: existing, functionGlobalContext: { existing } };
  try {
    assert.equal(registerSettings(settings, { ...config, sink: event => events.push(event) }), true);
    assert.equal(settings.httpNodeMiddleware, middleware); assert.equal(settings.adminAuth, existing);
    assert.equal(settings.functionGlobalContext.existing, existing); assert.equal(events.length, 0);
    const receipt = JSON.parse(fs.readFileSync(config.receiptPath));
    assert.equal(receipt.scope, SUBSCRIPTION_BOOKING_SCOPE); assert.equal(receipt.selfTestPassed, true);
    assert.equal(receipt.pid, process.pid); assert.equal(receipt.generation, config.generation);
    assert.equal(fs.statSync(config.receiptPath).mode & 0o777, 0o600);
    settings.functionGlobalContext.lkDiagnostics.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("registration refuses existing observer, malformed config and unsafe receipt parents", () => {
  const { root, config } = setup(), existing = { observe() {} }, globals = { lkDiagnostics: existing };
  try {
    assert.throws(() => registerSettings({ functionGlobalContext: globals }, config), /CONFLICT/);
    assert.throws(() => registerSettings({}, { ...config, bundleSha256: "invalid" }), /CONFIG/);
    const settings = { functionGlobalContext: { kept: true } }, before = settings.functionGlobalContext;
    fs.chmodSync(root, 0o755);
    assert.throws(() => registerSettings(settings, config), /DIRECTORY/);
    assert.equal(settings.functionGlobalContext, before); assert.equal(fs.existsSync(config.receiptPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("receipt failure restores previous globals, including absence", () => {
  const { root, config } = setup();
  try {
    fs.mkdirSync(config.receiptPath, { mode: 0o700 });
    const settings = {};
    assert.throws(() => registerSettings(settings, config), /RECEIPT_FILE/);
    assert.equal(Object.hasOwn(settings, "functionGlobalContext"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("post-rename directory fsync failure retains the observer behind the published ready receipt", () => {
  const { root, config } = setup(), settings = {}, originalFsync = fs.fsyncSync, originalWarn = console.warn;
  let warning;
  try {
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(Error("synthetic-fsync"), { code: "EIO" }); return originalFsync(fd); };
    console.warn = line => { warning = JSON.parse(line); };
    assert.equal(registerSettings(settings, config), true);
    const ready = JSON.parse(fs.readFileSync(config.receiptPath));
    assert.equal(ready.registered, true); assert.equal(ready.pid, process.pid);
    assert.equal(settings.functionGlobalContext.lkDiagnostics.scope, SUBSCRIPTION_BOOKING_SCOPE);
    assert.equal(warning.code, "OBSERVER_READY_DURABILITY_UNKNOWN");
    settings.functionGlobalContext.lkDiagnostics.dispose();
  } finally {
    fs.fsyncSync = originalFsync; console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
