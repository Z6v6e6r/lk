import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/components/auth/VivaAuthForm.tsx", "utf8");
const consentSource = fs.readFileSync("src/utils/authConsents.ts", "utf8");

test("Viva auth requires offer and personal data consents before login", () => {
  assert.match(source, /hasRequiredConsents = hasAcceptedOffer && hasAcceptedPersonalData/);
  assert.equal((source.match(/disabled=\{isLoading \|\| !hasRequiredConsents\}/g) || []).length, 3);
  assert.match(source, /if \(!hasRequiredConsents\) return;[\s\S]*startOAuth\(provider\)/);
  assert.match(source, /if \(!allowPhoneLogin \|\| !hasRequiredConsents\) return;[\s\S]*setStep\("phone"\)/);
});

test("Viva auth consent links use the official PadlHub documents", () => {
  assert.match(source, /href=\{AUTH_CONSENT_DOCUMENTS\[0\]\.url\}[\s\S]*публичной оферты/);
  assert.match(source, /href=\{AUTH_CONSENT_DOCUMENTS\[1\]\.url\}[\s\S]*обработку персональных данных/);
  assert.match(consentSource, /url: "https:\/\/padlhub\.ru\/docs"/);
  assert.match(consentSource, /url: "https:\/\/padlhub\.ru\/politica"/);
  assert.equal((source.match(/target="_blank"/g) || []).length, 2);
  assert.equal((source.match(/rel="noopener noreferrer"/g) || []).length, 2);
});

test("Viva auth renders consents between OAuth providers and more options", () => {
  const yandexButton = source.indexOf('provider="yandex"');
  const consents = source.indexOf('<fieldset className="auth-consents">');
  const moreOptions = source.indexOf('<div className="auth-more-options">');

  assert.ok(yandexButton >= 0 && yandexButton < consents);
  assert.ok(consents < moreOptions);
  assert.equal((source.match(/type="checkbox"/g) || []).length, 2);
});
