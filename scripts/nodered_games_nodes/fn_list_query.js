const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `7${s}`;
  if (s.length === 11 && s.startsWith("8")) return `7${s.slice(1)}`;
  return s;
};

const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const parseBookingIds = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => toStr(item))
      .filter(Boolean);
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

const q = msg.req?.query || {};
const phone = normPhone(q.phone || q.phoneNumber || q.userPhone || q.mobile);
const paymentRef = toStr(q.paymentRef || q.phPaymentRef);
const bookingIds = uniq(parseBookingIds(q.bookingIds));

if (!phone && !paymentRef && bookingIds.length === 0) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "phone or paymentRef or bookingIds is required" };
  return [null, msg, msg];
}

const includePast = String(q.includePast || "").toLowerCase() === "true";
const limitRaw = Number(q.limit);
const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : null;
const nowTs = Date.now();

const orConditions = [];

if (phone) {
  orConditions.push(
    { "organizer.phoneNorm": phone },
    { allRelatedPhones: phone },
    { participantPhones: phone },
    { waitlistPhones: phone },
    { invitedPhones: phone },
  );
}

if (paymentRef) {
  orConditions.push(
    { "metadata.paymentRef": paymentRef },
    { "payment.paymentRef": paymentRef },
  );
}

if (bookingIds.length > 0) {
  orConditions.push(
    { "booking.bookingIds": { $in: bookingIds } },
    { "metadata.bookingIds": { $in: bookingIds } },
    { "payment.bookingIds": { $in: bookingIds } },
  );
}

const mongoQuery = {
  archived: { $ne: true },
  $or: orConditions,
};

if (!includePast) {
  mongoQuery.$and = [
    {
      $or: [
        { "booking.endTs": { $gte: nowTs } },
        {
          $and: [
            { "booking.endTs": { $exists: false } },
            { "booking.startTs": { $gte: nowTs } },
          ],
        },
        {
          $and: [
            { "booking.endTs": { $exists: false } },
            { "booking.startTs": { $exists: false } },
          ],
        },
      ],
    },
  ];
}

msg._lkPhone = phone || null;
msg._lkIncludePast = includePast;
msg._lkLimit = limit;
msg._lkPaymentRef = paymentRef || null;
msg._lkBookingIds = bookingIds;
msg.payload = mongoQuery;
return [msg, null, msg];
