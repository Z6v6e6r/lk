import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const workspaceRoot = process.cwd();
const stationFunctionPath = path.join(
  workspaceRoot,
  "scripts/nodered_onboarding_nodes/fn_onboarding_stations.js",
);
const patcherPath = path.join(workspaceRoot, "scripts/patch_nodered_onboarding_stations_flow.mjs");

function runStationFunction() {
  const warnings: string[] = [];
  const context = {
    msg: {},
    node: { warn: (message: unknown) => warnings.push(String(message)) },
  };
  const source = fs.readFileSync(stationFunctionPath, "utf8");
  const result = new vm.Script(`(function () { ${source}\n})()`).runInNewContext(context);
  return { result, warnings };
}

test("station catalog exposes corrected court counts, Piter, and planned inactive stations", () => {
  const { result, warnings } = runStationFunction();
  const stations = result.payload.stations as Array<Record<string, unknown>>;
  const byName = new Map(stations.map((station) => [station.name, station]));

  assert.deepEqual(
    {
      panoramic: byName.get("Терехово")?.panoramicCourtsCount,
      outdoor: byName.get("Терехово")?.outdoorCourtsCount,
    },
    { panoramic: 4, outdoor: 2 },
  );
  assert.deepEqual(
    {
      panoramic: byName.get("Сколково")?.panoramicCourtsCount,
      singles: byName.get("Сколково")?.singleCourtsCount,
    },
    { panoramic: 6, singles: 1 },
  );
  assert.equal(byName.get("Нагатинская")?.singleCourtsCount, 2);
  assert.equal(byName.get("Нагатинская Премиум")?.singleCourtsCount, 2);
  assert.equal(byName.get("Ясенево")?.panoramicCourtsCount, 4);
  assert.equal(byName.get("Селигерская")?.singleCourtsCount, 1);
  assert.deepEqual(
    {
      id: byName.get("Питер")?.id,
      masterServiceId: byName.get("Питер")?.masterServiceId,
      preferredSubServiceId: byName.get("Питер")?.preferredSubServiceId,
      subServiceIds: Array.from((byName.get("Питер")?.subServiceIds as string[]) ?? []),
    },
    {
      id: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
      masterServiceId: "899db365-5286-43f6-a3a4-efcf406a28eb",
      preferredSubServiceId: "6a16a7a8-db84-422d-b5f8-5fd00fe0d54c",
      subServiceIds: ["6a16a7a8-db84-422d-b5f8-5fd00fe0d54c"],
    },
  );

  for (const name of ["Котельники", "Щербинка", "Люберцы", "Коломна"]) {
    assert.equal(byName.get(name)?.isActive, false, `${name} must remain inactive`);
    assert.match(String(byName.get(name)?.id), /^planned-/);
  }
  assert.deepEqual(warnings, []);
});

test("station patcher changes only the function wired from the station route", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-stations-test-"));
  const sourcePath = path.join(tempDir, "source.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const sourceFlow = [
    {
      id: "route",
      type: "http in",
      url: "/lk/onboarding/stations",
      wires: [["station-fn", "response"]],
    },
    { id: "station-fn", type: "function", func: "return msg;", wires: [["response"]] },
    { id: "response", type: "http response", wires: [] },
    { id: "unrelated", type: "function", func: "return null;", wires: [] },
  ];

  try {
    fs.writeFileSync(sourcePath, JSON.stringify(sourceFlow), "utf8");
    execFileSync(process.execPath, [patcherPath, sourcePath, outputPath], {
      cwd: workspaceRoot,
      stdio: "pipe",
    });
    const candidate = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(candidate.length, sourceFlow.length);
    assert.match(candidate.find((node: { id: string }) => node.id === "station-fn").func, /Питер/);
    assert.equal(
      candidate.find((node: { id: string }) => node.id === "unrelated").func,
      "return null;",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
