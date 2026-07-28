import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

function runFunction(fileName: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(path.join(ROOT, "scripts/nodered_padel_day_nodes", fileName), "utf8");
  return new Function("msg", source)(msg);
}

test("booking gate rejects an existing active direction 5245 booking on another station or event date", () => {
  const result = runFunction("fn_padel_day_guard_bookings.js", {
    statusCode: 200,
    padelDay: { eventDate: "2026-07-29", exerciseId: "new-exercise", authHeader: "Bearer token" },
    payload: { content: [{
      id: "booking-1",
      isCancelled: false,
      exercise: {
        id: "other-station-exercise",
        timeFrom: "2026-07-26T12:00:00+03:00",
        direction: { id: 5245 },
        studio: { id: "other-station" },
      },
    }] },
  }) as [unknown, { statusCode: number; payload: { code: string } }];
  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 409);
  assert.equal(result[1].payload.code, "PADEL_DAY_ALREADY_BOOKED");
});

test("exercise validation builds deterministic per-client lock and validates type/date", () => {
  const msg = {
    statusCode: 200,
    padelDay: {
      eventDate: "2026-07-29",
      exerciseId: "0026afd7-f265-4ed7-9804-9341f31e84d1",
      clientId: "client-1",
      idempotencyKey: "idem-1",
    },
    payload: {
      id: "0026afd7-f265-4ed7-9804-9341f31e84d1",
      direction: { id: 5245 },
      type: { id: 1279 },
      timeFrom: "2026-07-29T07:00:00+03:00",
      clientsCount: 0,
      maxClientsCount: 4,
    },
  };
  const result = runFunction("fn_padel_day_guard_exercise.js", msg) as [{ query: { _id: string }; padelDay: { guardId: string } }, unknown];
  assert.equal(result[1], null);
  assert.equal(result[0].query._id, "iSkq6G:direction-5245:client-1");
  assert.ok(result[0].padelDay.guardId);
});

test("waitlist validates two consents and builds a separate waitlist upsert", () => {
  const result = runFunction("fn_padel_day_waitlist_prepare.js", {
    payload: { firstName: "Анна", lastName: "Иванова", phone: "+7 (999) 123-45-67", personalDataConsent: true, offerConsent: true },
  }) as [{ query: { _id: string }; payload: { $set: { phone: string; status: string } } }, unknown];
  assert.equal(result[1], null);
  assert.equal(result[0].query._id, "iSkq6G:padel-day-waitlist:79991234567");
  assert.equal(result[0].payload.$set.phone, "79991234567");
  assert.equal(result[0].payload.$set.status, "WAITING");
});

test("patch script creates isolated Padel Day tab, routes and import", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lk-padel-day-flow-"));
  const source = path.join(temp, "source.flow.json");
  const importPath = path.join(temp, "lk_padel_day.import.json");
  const nodesImportPath = path.join(temp, "lk_padel_day.nodes.import.json");
  fs.writeFileSync(source, JSON.stringify([
    { id: "existing-tab", type: "tab", label: "Existing", disabled: false },
    { id: "mongo-client", type: "mongodb4-client", name: "main" },
    { id: "mongo-use", type: "mongodb4", z: "existing-tab", clientNode: "mongo-client", collection: "x", operation: "find", wires: [[]] },
  ]), "utf8");

  const result = spawnSync("node", ["scripts/patch_nodered_padel_day_flow.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NODERED_SOURCE_PATH: source,
      PADEL_DAY_IMPORT_PATH: importPath,
      PADEL_DAY_NODES_IMPORT_PATH: nodesImportPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const flow = JSON.parse(fs.readFileSync(source, "utf8")) as Array<Record<string, unknown>>;
  assert.equal(flow.filter((node) => node.type === "tab" && node.label === "LK Padel Day").length, 1);
  assert.equal(flow.filter((node) => node.type === "http in" && node.url === "/lk/padel-day/guard" && node.method === "post").length, 1);
  assert.equal(flow.filter((node) => node.type === "http in" && node.url === "/lk/padel-day/waitlist" && node.method === "post").length, 1);
  assert.equal(flow.filter((node) => node.type === "mongodb4" && node.collection === "lk_padel_day_waitlist").length, 1);
  assert.ok(fs.existsSync(importPath));
  assert.ok(fs.existsSync(nodesImportPath));
});
