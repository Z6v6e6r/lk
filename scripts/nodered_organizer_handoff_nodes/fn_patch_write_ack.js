if (msg.error || msg.payload?.acknowledged !== true || msg.payload?.matchedCount !== 1) {
  msg.statusCode = 409;
  msg.payload = { code: "GAME_PATCH_CONFLICT", error: "Игра изменилась. Обновите её перед сохранением." };
  return [msg, null];
}
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const phoneFieldPattern = /(?:^|[^a-z0-9])(?:phones?|mobiles?|telephones?|msisdn)(?:[^a-z0-9]|$)/i;
const isPhoneField = (key) => phoneFieldPattern.test(
  String(key || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
);
const phoneIdentityPattern = /^(phone|mobile|telephone|msisdn):/i;
const exactPhoneValuePattern = /^(?:\+?7|8)(?:[\s().-]*\d){10}$/;
const embeddedPhoneValuePattern = /(^|[^\d])((?:\+?7|8)(?:[\s().-]*\d){10})(?!\d)/g;
const phoneQueryValuePattern = /([?&][^=&#]*(?:phone|mobile|telephone|msisdn)[^=&#]*=)[^&#]*/gi;
// A canonical UUID can contain an 11-digit phone-shaped run across its hyphens.
// Preserve only complete UUID spans; phone fields/identities/query values still
// take precedence, and text surrounding each UUID remains subject to redaction.
const uuidSpanPattern = /((?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f]))/gi;
const isPlainRecord = (value) => {
  if (!isObj(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructor = Object.prototype.hasOwnProperty.call(prototype, "constructor")
    ? prototype.constructor
    : null;
  // MongoDB results enter a Node-RED Function from a different VM realm, so
  // their Object.prototype is not reference-equal to the sandbox prototype.
  // Constructor identity by name still excludes Date, Buffer, BSON/ObjectId,
  // and other special instances that must keep their serialization behavior.
  return typeof constructor === "function" && constructor.name === "Object";
};

const redactPhoneString = (value) => {
  const trimmed = value.trim();
  if (phoneIdentityPattern.test(trimmed) || exactPhoneValuePattern.test(trimmed)) {
    return null;
  }
  return value
    .replace(phoneQueryValuePattern, "$1[redacted]")
    .split(uuidSpanPattern)
    .map((part, index) => index % 2 === 1
      ? part
      : part.replace(embeddedPhoneValuePattern, "$1[redacted]"))
    .join("");
};

const redactPhoneData = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => redactPhoneData(item));
  }
  if (isPlainRecord(value)) {
    const next = {};
    Object.entries(value).forEach(([key, item]) => {
      if (isPhoneField(key)) return;
      const redacted = redactPhoneData(item);
      if (redacted !== null || item === null) {
        next[key] = redacted;
      }
    });
    return next;
  }
  if (typeof value === "string") {
    return redactPhoneString(value);
  }
  if (
    typeof value === "number"
    && Number.isInteger(value)
    && exactPhoneValuePattern.test(String(value))
  ) {
    return null;
  }
  return value;
};


const followup = { ...msg, payload: { id: msg._organizerPatchResponse?.id, archived: { $ne: true } }, _gameAutojoinPatch: msg._organizerPatchAutojoin };
msg.statusCode = 200;
msg.payload = redactPhoneData(msg._organizerPatchResponse);
return [msg, followup];
