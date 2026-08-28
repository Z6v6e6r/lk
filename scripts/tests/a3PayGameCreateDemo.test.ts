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
const devBookingApiSource = await readFile(
  new URL("../../src/components/games/a3PayDevVivaBookingApi.ts", import.meta.url),
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

test("primary A3.pay action opens the guarded confirmation UI", () => {
  const buttonStart = demoSource.indexOf('data-testid="a3pay-game-create-demo-button"');
  const modalStart = demoSource.indexOf("<Modal", buttonStart);
  assert.notEqual(buttonStart, -1);
  assert.notEqual(modalStart, -1);

  const demoButtonSource = demoSource.slice(buttonStart, modalStart);
  assert.match(demoButtonSource, /onClick=\{handleOpen\}/);
  assert.doesNotMatch(demoButtonSource, /handleMasterServicePay|handleSplitGamePay|fetch\s*\(/);
});

test("demo clearly separates real Viva booking from A3 invoice and game creation", () => {
  assert.doesNotMatch(demoSource, /A3\.pay · демо, платёж не выполняется/);
  assert.match(demoSource, /Счёт A3\.pay и игра пока не создаются/);
  assert.match(demoSource, /настоящую неоплаченную бронь в Viva/);
  assert.match(demoSource, /Отменить тестовую бронь/);
  assert.match(demoSource, /bookingRequiresCancellation = phase === "booking" \|\| phase === "cancel"/);
  assert.match(demoSource, /phase === "cancel"\s*\? "Проверить отмену в Viva"/);
  assert.match(demoSource, /if \(bookingRequiresCancellation \|\| loading\) return/);
});

test("dev Viva client uses the reserve SERV2 route with no retry or production fallback", () => {
  assert.match(devBookingApiSource, /if \(!IS_DEV_RELEASE_CHANNEL\)/);
  assert.match(devBookingApiSource, /const url = `\$\{SERV2\}\$\{ENDPOINT\}/);
  assert.match(devBookingApiSource, /X-PadlHub-Release-Channel/);
  assert.match(devBookingApiSource, /catch \{\s*return null;/);
  assert.doesNotMatch(devBookingApiSource, /SERV2_FALLBACK|retries|apiPayMasterService/);
});

test("active operation survives tab loss and restores through a read-only status request", () => {
  assert.match(devBookingApiSource, /window\.localStorage/);
  assert.match(devBookingApiSource, /requestA3PayDevVivaBooking\("status", operationId\)/);
  assert.match(demoSource, /next\.status === 404/);
  assert.match(demoSource, /next\.data\?\.state === "PREPARED"/);
  assert.doesNotMatch(devBookingApiSource, /window\.sessionStorage/);
});
