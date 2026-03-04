const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};

const q = msg.req?.query || {};
const phone = normPhone(q.phone || q.phoneNumber || q.userPhone || q.mobile);
if (!phone) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "phone is required" };
  return [null, msg, msg];
}

const includePast = String(q.includePast || "").toLowerCase() === "true";
const nowTs = Date.now();

const mongoQuery = {
  archived: { $ne: true },
  $or: [
    { "organizer.phoneNorm": phone },
    { allRelatedPhones: phone },
    { participantPhones: phone },
    { waitlistPhones: phone },
    { invitedPhones: phone },
  ],
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

msg._lkPhone = phone;
msg._lkIncludePast = includePast;
msg.payload = mongoQuery;
return [msg, null, msg];
