import assert from "node:assert/strict";
import test from "node:test";
import { scanNginxInventoryStatements } from "../partner_game_membership_nginx_lexical.mjs";
import { verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";

const values = text => scanNginxInventoryStatements(text).map(words => words.map(word => word.value));
const fixture = regex => `server {\n  location ~ ${regex} {\n    return 404;\n  }\n}\n`;

test("regression: unquoted regex hash does not hide the opening block", () => {
  assert.deepEqual(values(fixture("^/synthetic/[^/?#]+$")), [["return", "404"]]);
  // Only the hash is substituted; the same surrounding structure must survive.
  assert.deepEqual(values(fixture("^/synthetic/[^/?#]+$")), values(fixture("^/synthetic/[^/?X]+$")));
});

test("regression retains line 465 after synthetic padding, not a production export", () => {
  const lines = ["server {", ...Array(460).fill("# synthetic padding"), "location ~ ^/synthetic/[^/?#]+$ {", "return 404;", "}", "}"];
  assert.equal(lines.length, 465);
  const rows = scanNginxInventoryStatements(lines.join("\n"));
  assert.equal(rows[0][0].line, 463);
  assert.deepEqual(rows[0].map(token => token.value), ["return", "404"]);
});

for (const [name, input, expected] of [
  ["hash inside an ordinary word", "set $value abc#def;", [["set", "$value", "abc#def"]]],
  ["multiple literal hashes", "set $value abc##def;", [["set", "$value", "abc##def"]]],
  ["regex stored as a word retains its value", "map $uri $x { ~^/[^/?#]+$ yes; }", [["~^/[^/?#]+$", "yes"]]],
  ["full-line comment", "# } { fake secret;\nreturn 404;", [["return", "404"]]],
  ["trailing comment at a token boundary", "return 404;# } fake secret;\n", [["return", "404"]]],
  ["comment between directive tokens", "return # } fake\n404;", [["return", "404"]]],
  ["double quoted hash", 'set $value "#{};";', [["set", "$value", "#{};"]]],
  ["single quoted hash", "set $value '#{};';", [["set", "$value", "#{};"]]],
  ["escaped hash at word start", String.raw`set $value \#literal;`, [["set", "$value", "#literal"]]],
  ["variable braces", "proxy_set_header Host ${host};", [["proxy_set_header", "Host", "${host}"]]],
  ["empty quoted value", 'set $value "";', [["set", "$value", ""]]],
  ["CRLF comment termination", "# }\r\nreturn 404;", [["return", "404"]]],
]) test(name, () => assert.deepEqual(values(input), expected));

for (const [name, input, code] of [
  ["unknown input type", {}, "INPUT_REJECTED"],
  ["byte cap", "x".repeat(131073), "INPUT_REJECTED"],
  ["UTF8 byte cap", "я".repeat(65537), "INPUT_REJECTED"],
  ["NUL rejected", "return\0 404;", "INPUT_REJECTED"],
  ["punctuation token cap", ";".repeat(50001), "TOKEN_LIMIT"],
  ["depth cap", "http {".repeat(257) + "}".repeat(257), "DEPTH_LIMIT"],
  ["unnamed block", "{}", "UNNAMED_BLOCK"],
  ["unbalanced close remains rejected", "server { return 404; }}", "UNBALANCED_CLOSE"],
  ["missing close", "server { return 404;", "UNBALANCED_BLOCKS_AT_EOF"],
  ["missing semicolon", "server { return 404 }", "UNTERMINATED_DIRECTIVE_BEFORE_CLOSE"],
  ["truncated directive", "return 404", "UNTERMINATED_DIRECTIVE_AT_EOF"],
  ["unterminated quote", 'set $value "secret;', "UNTERMINATED_QUOTE"],
  ["dangling escape", "set $value \\", "DANGLING_ESCAPE"],
  ["unterminated variable", "set $value ${secret;", "UNSUPPORTED_VARIABLE"],
]) test(`rejects ${name}`, () => assert.throws(() => values(input), error => error.code === `NGINX_LEXICAL_${code}`));

test("malformed input is redacted from error and metadata", () => {
  const secret = "SYNTHETIC_VALUE_NOT_A_CREDENTIAL";
  assert.throws(() => values(`set $value "${secret}`), error => {
    assert.equal(error.code, "NGINX_LEXICAL_UNTERMINATED_QUOTE");
    assert.equal(error.line, 1);
    assert.ok(!String(error).includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});

test("escaped newline still counts toward diagnostic line numbers", () => {
  const rows = scanNginxInventoryStatements("set $value a\\\nb;\nreturn 404;");
  assert.equal(rows[1][0].line, 3);
});

test("lexical success cannot open the production verifier", () => {
  assert.deepEqual(values("server { return 503; }"), [["return", "503"]]);
  assert.throws(() => verifyPartnerProductionIngress(), /UNSUPPORTED_INGRESS_ADAPTER/);
});
