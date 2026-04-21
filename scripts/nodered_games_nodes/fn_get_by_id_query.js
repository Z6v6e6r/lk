const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const parseBookingIds = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => toStr(item)).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

const gameId = toStr(msg.req?.params?.gameId);
const q = msg.req?.query || {};
const paymentRef = toStr(q.paymentRef || q.phPaymentRef);
const bookingIds = uniq(parseBookingIds(q.bookingIds));

if (gameId) {
  msg.payload = { id: gameId, archived: { $ne: true } };
  return [msg, null];
}

if (paymentRef) {
  msg.payload = {
    archived: { $ne: true },
    $or: [
      { "metadata.paymentRef": paymentRef },
      { "payment.paymentRef": paymentRef },
    ],
  };
  return [msg, null];
}

if (bookingIds.length > 0) {
  msg.payload = {
    archived: { $ne: true },
    $or: [
      { "booking.bookingIds": { $in: bookingIds } },
      { "metadata.bookingIds": { $in: bookingIds } },
      { "payment.bookingIds": { $in: bookingIds } },
    ],
  };
  return [msg, null];
}

msg.statusCode = 400;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = { error: "gameId or paymentRef or bookingIds is required" };
return [null, msg];
