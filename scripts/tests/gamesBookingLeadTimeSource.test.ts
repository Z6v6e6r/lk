import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gamesSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("visible game slots are filtered by the 30-minute lead-time guard", () => {
  const slotsStart = gamesSource.indexOf("const durationScopedSlots = useMemo");
  const slotsEnd = gamesSource.indexOf("const availableCourts = useMemo", slotsStart);
  const slotsSource = gamesSource.slice(slotsStart, slotsEnd);

  assert.ok(slotsStart >= 0 && slotsEnd > slotsStart, "duration-scoped slot selector must exist");
  assert.match(slotsSource, /checkGameBookingLeadTime\(/);
  assert.match(slotsSource, /bookingLeadTimeNowTs/);
});

test("payment rejection explains the 30-minute lead time", () => {
  assert.match(
    gamesSource,
    /Бронирование доступно минимум за \$\{GAME_BOOKING_MIN_LEAD_MINUTES\} минут до начала/,
  );
});

test("self payment revalidates the selected slot before calling Viva pay", () => {
  const handlerStart = gamesSource.indexOf("const handleMasterServicePay = useCallback");
  const handlerEnd = gamesSource.indexOf("const handleCreateSubmit = useCallback", handlerStart);
  const handlerSource = gamesSource.slice(handlerStart, handlerEnd);
  const revalidateIndex = handlerSource.indexOf("await revalidateSelectedSlotForPayment()");
  const payIndex = handlerSource.indexOf("await apiPayMasterService(");

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "self-payment handler must exist");
  assert.ok(revalidateIndex >= 0, "self-payment must revalidate the selected slot");
  assert.ok(payIndex > revalidateIndex, "self-payment revalidation must run before Viva pay");
});

test("split payment revalidates the selected slot before creating payment", () => {
  const handlerStart = gamesSource.indexOf("const handleSplitGamePay = useCallback");
  const handlerEnd = gamesSource.indexOf("const handleMasterServicePay = useCallback", handlerStart);
  const handlerSource = gamesSource.slice(handlerStart, handlerEnd);
  const revalidateIndex = handlerSource.indexOf("await revalidateSelectedSlotForPayment()");
  const payIndex = handlerSource.indexOf("await apiCreatePadelSplitGamePayment(");

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "split-payment handler must exist");
  assert.ok(revalidateIndex >= 0, "split payment must revalidate the selected slot");
  assert.ok(payIndex > revalidateIndex, "split revalidation must run before payment creation");
});

test("slot revalidation fails closed when Viva cannot confirm availability", () => {
  const guardStart = gamesSource.indexOf("const revalidateSelectedSlotForPayment = useCallback");
  const guardEnd = gamesSource.indexOf("const promoSelectionKey", guardStart);
  const guardSource = gamesSource.slice(guardStart, guardEnd);

  assert.ok(guardStart >= 0 && guardEnd > guardStart, "payment slot revalidation guard must exist");
  assert.match(guardSource, /if \(result\.error\)/);
  assert.match(guardSource, /if \(!hasRevalidatedGameSlot\(/);
  assert.match(guardSource, /catch \{/);
  assert.match(guardSource, /return false;/);
});
