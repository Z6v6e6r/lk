import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const assignmentPath = "docs/ab-leto-trainer-qr-assignment.csv";

test("trainer QR assignment table contains the complete unique TR-001..TR-050 range", () => {
  const rows = fs.readFileSync(assignmentPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",").map((value) => (
      value.trim().replace(/^"|"$/g, "").replace(/""/g, "\"")
    )));

  assert.equal(rows.length, 50);
  assert.deepEqual(
    rows.map((row) => row[1]),
    Array.from({ length: 50 }, (_, index) => `TR-${String(index + 1).padStart(3, "0")}`),
  );
  assert.equal(new Set(rows.map((row) => row[1])).size, 50);
  for (const row of rows) {
    assert.equal(row[3], `https://padlhub.ru/ab_leto?qr=${row[1]}`);
  }
});
