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
const phoneWithPlus = phone && !String(phone).startsWith("+") ? `+${phone}` : phone;
const paymentRef = toStr(q.paymentRef || q.phPaymentRef);
const bookingIds = uniq(parseBookingIds(q.bookingIds));
const clientId = toStr(q.clientId || q.profileId || q.userId || q.playerId);
const publicMode = ["true", "1", "yes", "available", "find"]
  .includes(String(q.public || q.available || q.find || "").trim().toLowerCase());
const stationId = toStr(q.stationId || q.studioId);
const stationName = toStr(q.stationName || q.studioName || q.station || q.studio);
const date = toStr(q.date || q.bookingDate || q.gameDate);

if (!publicMode && !phone && !paymentRef && bookingIds.length === 0 && !clientId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "phone or clientId or paymentRef or bookingIds is required" };
  return [null, msg, msg];
}

const includePast = String(q.includePast || "").toLowerCase() === "true";
const needsResult = ["true", "1", "yes"]
  .includes(String(q.needsResult || q.withoutConfirmedResult || "").trim().toLowerCase());
const windowHoursRaw = Number(q.windowHours || q.resultWindowHours);
const windowHours = Number.isFinite(windowHoursRaw)
  ? Math.max(1, Math.min(168, Math.floor(windowHoursRaw)))
  : null;
const limitRaw = Number(q.limit);
const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : null;
const offsetRaw = Number(q.offset || q.skip || q.from);
const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
const nowTs = Date.now();

const orConditions = [];

if (phone) {
  orConditions.push(
    { "organizer.phoneNorm": phone },
    { "metadata.organizerPhoneNorm": phone },
    { "metadata.organizerPhone": phone },
    { allRelatedPhones: phone },
    { participantPhones: phone },
    { waitlistPhones: phone },
    { invitedPhones: phone },
    { "participants.phoneNorm": phone },
    { "waitlist.phoneNorm": phone },
    { "metadata.splitPayment.payments.clientPhoneNorm": phone },
    { "metadata.splitPayment.payments.phoneNorm": phone },
    { "metadata.splitPayment.payments.clientPhone": phone },
    { "metadata.splitPayment.payments.phone": phone },
  );
  if (phoneWithPlus && phoneWithPlus !== phone) {
    orConditions.push(
      { allRelatedPhones: phoneWithPlus },
      { participantPhones: phoneWithPlus },
      { waitlistPhones: phoneWithPlus },
      { invitedPhones: phoneWithPlus },
      { "metadata.splitPayment.payments.clientPhone": phoneWithPlus },
      { "metadata.splitPayment.payments.phone": phoneWithPlus },
    );
  }
}

if (clientId) {
  orConditions.push(
    { "organizer.id": clientId },
    { "metadata.organizerId": clientId },
    { allRelatedClientIds: clientId },
    { participantIds: clientId },
    { waitlistIds: clientId },
    { "participants.id": clientId },
    { "waitlist.id": clientId },
    { "metadata.splitPayment.payments.clientId": clientId },
    { "metadata.splitPayment.payments.playerId": clientId },
  );
}

if (paymentRef) {
  orConditions.push(
    { "metadata.paymentRef": paymentRef },
    { "metadata.splitPayment.paymentRef": paymentRef },
    { "metadata.splitPayment.payments.paymentRef": paymentRef },
    { "payment.paymentRef": paymentRef },
  );
}

if (bookingIds.length > 0) {
  orConditions.push(
    { "booking.bookingIds": { $in: bookingIds } },
    { "booking.bookingId": { $in: bookingIds } },
    { "metadata.bookingIds": { $in: bookingIds } },
    { "metadata.bookingId": { $in: bookingIds } },
    { "metadata.splitPayment.bookingIds": { $in: bookingIds } },
    { "metadata.splitPayment.bookingId": { $in: bookingIds } },
    { "metadata.splitPayment.organizerBookingId": { $in: bookingIds } },
    { "metadata.splitPayment.payments.bookingIds": { $in: bookingIds } },
    { "metadata.splitPayment.payments.bookingId": { $in: bookingIds } },
    { "payment.bookingIds": { $in: bookingIds } },
    { "payment.bookingId": { $in: bookingIds } },
  );
}

const mongoQuery = {
  archived: { $ne: true },
};

if (orConditions.length > 0) {
  mongoQuery.$or = orConditions;
}

const andConditions = [];

if (!includePast) {
  andConditions.push({
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
  });
}

if (publicMode) {
  andConditions.push({
    $or: [
      { "settings.isPrivate": { $exists: false } },
      { "settings.isPrivate": { $ne: true } },
    ],
  });
  if (date) {
    andConditions.push({ "booking.date": date });
  }
  if (stationId) {
    andConditions.push({ "booking.studioId": stationId });
  }
}

if (andConditions.length > 0) {
  mongoQuery.$and = andConditions;
}

msg._lkPhone = phone || null;
msg._lkIncludePast = includePast;
msg._lkNeedsResult = needsResult;
msg._lkWindowHours = windowHours;
msg._lkLimit = limit;
msg._lkOffset = offset;
msg._lkPaymentRef = paymentRef || null;
msg._lkBookingIds = bookingIds;
msg._lkClientId = clientId || null;
msg._lkPublicMode = publicMode;
msg._lkStationId = stationId || null;
msg._lkStationName = stationName || null;
msg._lkDate = date || null;
msg.payload = mongoQuery;
return [msg, null, msg];
