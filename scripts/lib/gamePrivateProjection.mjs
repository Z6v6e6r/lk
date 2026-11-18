export function createGamePrivateProjection() {
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


const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => Array.isArray(value) ? value.map(clone)
  : isPlainRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
const stable = value => {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (phoneIdentityPattern.test(text) || exactPhoneValuePattern.test(text)) return null;
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text) ? text.toLowerCase() : text;
};
const bindingKeys = ["operationId", "paymentRef", "membershipId", "bookingId", "vivaBookingId", "memberKey", "id", "clientId", "playerId", "userId"];
const publicEqual = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, i) => publicEqual(item, right[i]));
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return keys.every(key => publicEqual(left[key] ?? null, right[key] ?? null));
};
const bindingError = () => { throw Error("GAME_PATCH_PRIVATE_BINDING_UNKNOWN"); };
const actorKeys = ["id", "clientId", "playerId", "userId", "uuid"];
const values = (row, keys) => [...new Set(keys.map(key => stable(row?.[key])).filter(Boolean))];
const matchRow = (submitted, canonicalRows, roster) => {
  const groups = roster ? [actorKeys, ["memberKey", "playerKey"], ["membershipId", "membership_id"], ["bookingId", "vivaBookingId"]]
    : [["operationId"], ["paymentRef"], ["membershipId", "membership_id"], ["bookingId", "vivaBookingId"], ["memberKey"], ["id"], ["clientId", "playerId", "userId"]];
  if (roster && values(submitted, actorKeys).length > 1) return bindingError();
  for (const keys of groups) {
    const supplied = values(submitted, keys);
    if (!supplied.length || !canonicalRows.some(row => values(row, keys).length)) continue;
    if (supplied.length > 1) return bindingError();
    let matches = canonicalRows.filter(row => values(row, keys).includes(supplied[0]));
    if (!matches.length) return null; // New binding: never borrow another booking's private fields.
    if (roster && matches.some(row => values(row, actorKeys).length > 1)) return bindingError();
    matches = matches.filter(row => bindingKeys.every(other => !stable(submitted[other]) || !stable(row[other]) || stable(submitted[other]) === stable(row[other])));
    if (!matches.length) return bindingError();
    if (matches.length > 1) return bindingError();
    if (matches.length !== 1) return bindingError();
    return matches[0];
  }
  if (bindingKeys.some(key => stable(submitted[key]))) return null;
  // Legacy rows require an exact full public projection, never name-only or position matching.
  const matches = canonicalRows.filter(row => publicEqual(redactPhoneData(row), submitted));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || canonicalRows.some(row => !publicEqual(redactPhoneData(row), row))) return bindingError();
  return null;
};
const restore = (submitted, canonical, depth = 0, roster = false) => {
  if (depth > 64) return bindingError();
  if (Array.isArray(submitted)) {
    const rows = Array.isArray(canonical) ? canonical : [];
    if (publicEqual(redactPhoneData(rows), rows)) return clone(submitted);
    return submitted.map(item => {
      if (!isPlainRecord(item)) {
        if (item === null && rows.some(row => row !== null && redactPhoneData(row) === null)) return bindingError();
        return clone(item);
      }
      const match = matchRow(item, rows.filter(isPlainRecord), roster);
      return match ? restore(item, match, depth + 1) : clone(item);
    });
  }
  if (!isPlainRecord(submitted) || !isPlainRecord(canonical)) {
    return publicEqual(submitted, redactPhoneData(canonical)) && !publicEqual(canonical, submitted) ? clone(canonical) : clone(submitted);
  }
  const result = { ...submitted };
  for (const [key, value] of Object.entries(canonical)) {
    const projected = isPhoneField(key) ? undefined : redactPhoneData(value);
    if ((!own(submitted, key) && (isPhoneField(key) || (projected === null && value !== null)))
      || (isPhoneField(key) && (submitted[key] === null || submitted[key] === ""))) result[key] = clone(value);
    else if (own(submitted, key)) result[key] = restore(submitted[key], value, depth + 1, ["participants", "waitlist", "players", "teamSlots", "allPlayers", "activeRoster", "playerPool"].includes(key));
  }
  return result;
};
return { project: redactPhoneData, restore, restoreRoster: (submitted, rows) => restore(submitted, rows, 0, true) };
}
