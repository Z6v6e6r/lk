import assert from "node:assert/strict";
import test from "node:test";
import { avatarFallbackUrl } from "../../src/components/UI/avatarFallback.ts";

const svg = (name: string, initials?: string) => decodeURIComponent(avatarFallbackUrl(name, initials).split(",")[1]);

test("avatar initials use the profile purple and support Cyrillic and whitespace", () => {
  assert.match(svg("  Анна\tПетрова  "), />АП<\/text>/);
  assert.match(svg("Анна Петрова"), /fill="#7353D9"/);
  assert.match(svg("Анна"), />А<\/text>/);
  assert.match(svg(" \n "), />\?<\/text>/);
  assert.match(svg("", "ВЫ"), />ВЫ<\/text>/);
});

test("avatar text cannot introduce SVG markup", () => {
  const result = svg("", '<script>&"');
  assert.ok(!result.includes("<script>"));
  assert.match(result, /&lt;SCRIPT&gt;&amp;&quot;/);
});
