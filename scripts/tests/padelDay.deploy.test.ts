import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("live import utility replaces only the Padel Day tab and keeps unrelated flow nodes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "padel-day-import-"));
  const flowPath = path.join(root, "flows.json");
  const importPath = path.join(root, "padel-day.import.json");
  fs.writeFileSync(flowPath, JSON.stringify([
    { id: "live-tab", type: "tab", label: "Live" },
    { id: "mongo-client", type: "mongodb4-client" },
    { id: "unchanged", type: "function", z: "live-tab", wires: [[]] },
    { id: "old-padel-tab", type: "tab", label: "LK Padel Day" },
    { id: "old-padel-node", type: "function", z: "old-padel-tab", wires: [[]] },
  ]), "utf8");
  fs.writeFileSync(importPath, JSON.stringify([
    { id: "lk_padel_day_5245", type: "tab", label: "LK Padel Day" },
    { id: "new-padel-node", type: "mongodb4", z: "lk_padel_day_5245", clientNode: "mongo-client", wires: [[]] },
    { id: "post-guard", type: "http in", z: "lk_padel_day_5245", method: "post", url: "/lk/padel-day/guard", wires: [[]] },
    { id: "post-mutation", type: "http in", z: "lk_padel_day_5245", method: "post", url: "/lk/padel-day/guard/:guardId/:action", wires: [[]] },
    { id: "options-guard", type: "http in", z: "lk_padel_day_5245", method: "options", url: "/lk/padel-day/guard", wires: [[]] },
    { id: "options-mutation", type: "http in", z: "lk_padel_day_5245", method: "options", url: "/lk/padel-day/guard/:guardId/:action", wires: [[]] },
    { id: "post-waitlist", type: "http in", z: "lk_padel_day_5245", method: "post", url: "/lk/padel-day/waitlist", wires: [[]] },
    { id: "options-waitlist", type: "http in", z: "lk_padel_day_5245", method: "options", url: "/lk/padel-day/waitlist", wires: [[]] },
  ]), "utf8");

  const result = spawnSync("node", ["scripts/apply_nodered_padel_day_import.mjs", flowPath, importPath], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const applied = JSON.parse(fs.readFileSync(flowPath, "utf8")) as Array<{ id: string; type: string; label?: string }>;
  assert.ok(applied.some((node) => node.id === "unchanged"));
  assert.ok(applied.some((node) => node.id === "new-padel-node"));
  assert.ok(!applied.some((node) => node.id === "old-padel-node"));
  assert.equal(applied.filter((node) => node.type === "tab" && node.label === "LK Padel Day").length, 1);
  assert.ok(fs.readdirSync(root).some((name) => name.includes("backup-padel-day")));
});
