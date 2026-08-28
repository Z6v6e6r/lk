import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gamesPageSource = await readFile(
  new URL("../../src/components/games/GamesPage.tsx", import.meta.url),
  "utf8",
);
const demoSource = await readFile(
  new URL("../../src/components/games/A3PayGameCreateDemo.tsx", import.meta.url),
  "utf8",
);
const apiConfigSource = await readFile(
  new URL("../../src/consts/api_config.tsx", import.meta.url),
  "utf8",
);

test("A3.pay game-create demo is guarded by the dev release channel", () => {
  assert.match(
    apiConfigSource,
    /IS_DEV_RELEASE_CHANNEL\s*=\s*import\.meta\.env\.MODE\s*===\s*["']dev["']/,
  );
  assert.match(
    gamesPageSource,
    /IS_DEV_RELEASE_CHANNEL\s*&&\s*\(\s*<A3PayGameCreateDemo/,
  );
});

test("demo action only opens local UI and does not call payment handlers", () => {
  const buttonStart = demoSource.indexOf('data-testid="a3pay-game-create-demo-button"');
  const modalStart = demoSource.indexOf("<Modal", buttonStart);
  assert.notEqual(buttonStart, -1);
  assert.notEqual(modalStart, -1);

  const demoButtonSource = demoSource.slice(buttonStart, modalStart);
  assert.match(demoButtonSource, /onClick=\{\(\) => setIsOpen\(true\)\}/);
  assert.doesNotMatch(demoButtonSource, /api[A-Z]|handleMasterServicePay|handleSplitGamePay|fetch\s*\(/);
});

test("demo clearly states that it creates no payment, booking, or game", () => {
  assert.match(demoSource, /демо, платёж не выполняется/);
  assert.match(demoSource, /Запрос на оплату не отправлен/);
  assert.match(demoSource, /Счёт A3\.pay, бронь Viva и игра не создаются\./);
});
