// A price on a converted open game would advertise a payable place while
// legacy join only changes the LK roster.
const rawJoinPrice = metadataInput.joinPrice;
const joinPrice = typeof rawJoinPrice === "string" && /^\d+(?:[.,]\d+)?$/.test(rawJoinPrice.trim())
  ? Number(rawJoinPrice.trim().replace(",", "."))
  : rawJoinPrice;
if (mode === "create" && isCabinetBookingConvert
  && (bookingConvertCategory === EXERCISE_CATEGORY_OPEN_GAME || bookingConvertDirectionId === 6180)
  && Number.isFinite(joinPrice) && joinPrice > 0) {
  const error = "Из этой брони нельзя открыть платный набор. Для оплаты отдельных мест создайте игру с раздельной оплатой.";
  const code = "BOOKING_CONVERT_PAID_JOIN_UNAVAILABLE";
  const response = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, code },
  });
  const debug = Object.assign({}, response, { payload: { action: "booking_convert_blocked", code } });
  return [null, response, debug, null];
}
