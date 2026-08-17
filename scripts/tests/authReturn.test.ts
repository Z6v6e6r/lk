import assert from "node:assert/strict";
import test from "node:test";
import {
  readPostAuthReturnUrl,
  resolveTrustedAuthReturnUrl,
} from "../../src/utils/authReturn.ts";

test("accepts trusted PadlHub return URLs for a standard auth journey", () => {
  const current = "https://padlhub.ru/lk_new?source=tournament_join";
  assert.equal(
    resolveTrustedAuthReturnUrl(
      "https://padlhub.ru/api/tournaments/public/weekend-cup/join",
      current,
    ),
    "https://padlhub.ru/api/tournaments/public/weekend-cup/join",
  );
  assert.equal(
    resolveTrustedAuthReturnUrl("https://padlhub.su/game_join?joinGame=game-1", current),
    "https://padlhub.su/game_join?joinGame=game-1",
  );
});

test("reads returnUrl only for supported post-auth sources", () => {
  const returnUrl = "https://padlhub.ru/api/tournaments/public/weekend-cup/join";
  assert.equal(
    readPostAuthReturnUrl(
      `https://padlhub.ru/lk_new?source=tournament_join&returnUrl=${encodeURIComponent(returnUrl)}`,
    ),
    returnUrl,
  );
  assert.equal(
    readPostAuthReturnUrl(
      `https://padlhub.ru/lk_new?source=tournament_level_recovery&returnUrl=${encodeURIComponent(returnUrl)}`,
    ),
    null,
  );
});

test("rejects unsafe external, credentialed and script return URLs", () => {
  const current = "https://padlhub.ru/lk_new?source=tournament_join";
  assert.equal(resolveTrustedAuthReturnUrl("https://evil.example/collect", current), null);
  assert.equal(resolveTrustedAuthReturnUrl("https://user:pass@padlhub.ru/collect", current), null);
  assert.equal(resolveTrustedAuthReturnUrl("javascript:alert(1)", current), null);
  assert.equal(resolveTrustedAuthReturnUrl("http://padlhub.ru/insecure", current), null);
});

test("allows loopback return only when the auth page is also local", () => {
  assert.equal(
    resolveTrustedAuthReturnUrl(
      "http://127.0.0.1:3108/api/tournaments/public/weekend-cup/join",
      "http://localhost:5173/lk_new?source=tournament_join",
    ),
    "http://127.0.0.1:3108/api/tournaments/public/weekend-cup/join",
  );
  assert.equal(
    resolveTrustedAuthReturnUrl(
      "http://127.0.0.1:3108/api/tournaments/public/weekend-cup/join",
      "https://padlhub.ru/lk_new?source=tournament_join",
    ),
    null,
  );
});
