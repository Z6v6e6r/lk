import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");

function extractFunctionSource(marker: string, nextMarker: string) {
  const start = source.indexOf(marker);
  const end = source.indexOf(nextMarker, start);

  assert.ok(start >= 0, `Cannot find function marker: ${marker}`);
  assert.ok(end > start, `Cannot find function boundary: ${nextMarker}`);

  return source.slice(start, end);
}

test("support event fallback identifies station-scoped client messages as TEXT", () => {
  const functionSource = extractFunctionSource(
    "export async function apiCreateSupportDialogEvent",
    "async function writePadelGameRecord",
  );
  const fallbackStart = functionSource.indexOf(": {\n        ...payload,");
  const fallbackEnd = functionSource.indexOf("\n      };", fallbackStart);

  assert.ok(fallbackStart >= 0, "support event fallback payload must exist");
  assert.ok(fallbackEnd > fallbackStart, "support event fallback payload must be bounded");

  const fallbackSource = functionSource.slice(fallbackStart, fallbackEnd);

  assert.match(fallbackSource, /kind:\s*"TEXT"/);
  assert.match(fallbackSource, /\{\s*stationId,\s*selectedStationId:\s*stationId\s*\}/);
  assert.match(fallbackSource, /\{\s*stationName,\s*selectedStationName:\s*stationName\s*\}/);
});
