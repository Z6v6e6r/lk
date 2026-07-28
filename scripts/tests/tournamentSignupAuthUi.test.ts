import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appCssSource = fs.readFileSync("src/MyApp.css", "utf8");
const tournamentSignupPageSource = fs.readFileSync(
  "src/components/tournament-signup/TournamentSignupPage.tsx",
  "utf8",
);
const vivaAuthFormSource = fs.readFileSync("src/components/auth/VivaAuthForm.tsx", "utf8");

test("tournament signup detail embeds a compact Viva auth form with required consents", () => {
  assert.match(
    tournamentSignupPageSource,
    /<section className="tournament-signup-section tournament-signup-detail">[\s\S]*?\{authRequired && \([\s\S]*?<AuthForm[\s\S]*?allowPhoneLogin=\{false\}/,
  );
  assert.ok(appCssSource.includes(
    ".tournament-signup-detail > .tournament-signup-auth > .auth-wrapper {\n  min-height: 0;\n  padding: 0;\n  background: transparent;\n  align-items: stretch;\n  justify-content: flex-start;",
  ));
  assert.ok(appCssSource.includes(
    ".tournament-signup-detail > .tournament-signup-auth > .auth-wrapper > .auth-card {\n  max-width: none;",
  ));
  assert.match(vivaAuthFormSource, /<fieldset className="auth-consents">/);
  assert.equal((vivaAuthFormSource.match(/type="checkbox"/g) || []).length, 2);
});
