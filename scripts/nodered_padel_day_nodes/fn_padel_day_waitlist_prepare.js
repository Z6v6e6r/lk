const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const compact = (value) => String(value || "").trim().replace(/\s+/g, " ");
const firstName = compact(body.firstName);
const lastName = compact(body.lastName);
const phone = String(body.phone || "").replace(/\D/g, "");

const respond = (statusCode, message) => {
  msg.statusCode = statusCode;
  msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
  msg.payload = { ok: false, code: "PADEL_DAY_WAITLIST_REJECTED", message };
  return [null, msg];
};

if (firstName.length < 2 || firstName.length > 80) return respond(400, "Укажите имя");
if (lastName.length < 2 || lastName.length > 80) return respond(400, "Укажите фамилию");
if (phone.length < 10 || phone.length > 15) return respond(400, "Укажите корректный телефон");
if (body.personalDataConsent !== true || body.offerConsent !== true) return respond(400, "Необходимо подтвердить согласие на обработку данных и оферту");

const now = new Date();
const waitlistId = `iSkq6G:padel-day-waitlist:${phone}`;
msg.query = { _id: waitlistId };
msg.payload = {
  $set: {
    tenantKey: "iSkq6G",
    firstName,
    lastName,
    phone,
    personalDataConsent: true,
    personalDataConsentAt: now,
    offerConsent: true,
    offerConsentAt: now,
    source: "padel-day",
    status: "WAITING",
    updatedAt: now,
  },
  $setOnInsert: { createdAt: now },
};
return [msg, null];
