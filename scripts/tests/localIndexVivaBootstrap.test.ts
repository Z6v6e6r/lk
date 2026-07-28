import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const VIVA_URL = "https://supadb.vivacrm.ru/storage/v1/object/public/widgets/d5685aa2-221b-439e-8bec-c6fda0846bc3.js";

function readFile(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("local index skips the Viva widget on localhost hosts", () => {
  const source = readFile("index.html");

  assert.doesNotMatch(
    source,
    new RegExp(`<script\\s+src="${VIVA_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"></script>`),
  );
  assert.match(source, /var isLocalHost = host === "localhost"/);
  assert.match(source, /if \(isLocalHost\) return;/);
  assert.match(source, /script\.src = vivaUrl;/);
});
