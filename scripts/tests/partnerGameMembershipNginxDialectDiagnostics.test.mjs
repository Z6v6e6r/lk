import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLocalSharedNginxDialect, readLocalSharedNginxRejection } from "../partner_game_membership_nginx_shared_dialect.mjs";
import { verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";

const main = "worker_processes auto; events { worker_connections 1024; }\nhttp {\ninclude /etc/nginx/private-fixture.conf;\n}";
const files = text => new Map([
  ["/etc/nginx/nginx.conf", Buffer.from(main)],
  ["/etc/nginx/private-fixture.conf", Buffer.from(text)],
]);
const rejection = input => {
  let caught;
  assert.throws(() => checkLocalSharedNginxDialect(input), error => { caught = error; return true; });
  return { error: caught, detail: readLocalSharedNginxRejection(caught) };
};

for (const [text, directive, reason] of [
  ["ssl_protocols TLSv1 TLSv1.2;", "ssl_protocols", "ARGUMENTS_UNSUPPORTED"],
  ['"ssl_protocols" PRIVATE_VALUE;', "ssl_protocols", "ARGUMENTS_UNSUPPORTED"],
  ["ssl_protocols {}", "ssl_protocols", "BLOCK_UNSUPPORTED"],
  ["PRIVATE_DIRECTIVE PRIVATE_VALUE;", "UNKNOWN", "DIRECTIVE_UNSUPPORTED"],
  ["PRIVATE_DIRECTIVE PRIVATE_VALUE {}", "UNKNOWN", "BLOCK_UNSUPPORTED"],
]) test(`inherited diagnostic classifies ${directive}/${reason}/${text.startsWith('"')}`, () => {
  const { error, detail } = rejection(files("# line one\n" + text));
  assert.equal(error.code, "NGINX_SHARED_DIALECT_INHERITED_UNSUPPORTED");
  assert.deepEqual(detail, { code: error.code, fileIndex: 1, line: 2, context: "HTTP", directive, reason });
  assert.ok(Object.isFrozen(detail));
  assert.doesNotMatch(JSON.stringify({ error, detail }), /PRIVATE_|private-fixture|TLSv1/);
  assert.equal(readLocalSharedNginxRejection({ ...error }), null);
  assert.throws(() => verifyPartnerProductionIngress(detail), /UNSUPPORTED_INGRESS_ADAPTER/);
});

test("diagnostic uses expanded include context and preserves first-rejection order", () => {
  const input = files("ssl_protocols TLSv1;\nPRIVATE_DIRECTIVE value;");
  assert.equal(rejection(input).detail.directive, "ssl_protocols");
  input.set("/etc/nginx/nginx.conf", Buffer.from(main.replace("include /etc/nginx/private-fixture.conf;", "server { include /etc/nginx/private-fixture.conf; }")));
  const { error, detail } = rejection(input);
  assert.equal(error.code, "NGINX_SHARED_DIALECT_EXPLICIT_DEFAULT_REQUIRED");
  assert.equal(detail, null);
});

test("no diagnostic is accepted from untrusted error fields, getters or primitives", () => {
  for (const input of [null, undefined, 1, "error", { code: "NGINX_SHARED_DIALECT_INHERITED_UNSUPPORTED" },
    { get code() { throw new Error("must not read"); } }]) {
    assert.equal(readLocalSharedNginxRejection(input), null);
  }
  assert.equal(rejection(files("ssl_protocols TLSv1.2 TLSv1.3;")).detail, null);
});
