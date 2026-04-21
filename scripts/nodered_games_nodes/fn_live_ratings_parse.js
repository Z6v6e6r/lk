const LK_FIELD_ID = "f9790818-25fd-4b73-a781-79c02720727d";
const NUM_FIELD_ID = "eabfe27b-3f72-4496-9185-1a2ec6e6465e";

const player = msg._livePlayer || {};
const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const getField = (client, id) => {
  const list = Array.isArray(client?.customFields) ? client.customFields : [];
  const found = list.find((field) => field && field.id === id);
  const value = Array.isArray(found?.value) ? found.value[0] : null;
  return value == null ? null : String(value).trim() || null;
};

if (msg.statusCode !== 200 || !msg.payload || typeof msg.payload !== "object") {
  msg.payload = {
    clientId: player.clientId || null,
    phoneNorm: player.phoneNorm || null,
    name: player.name || null,
    rating: player.rating || null,
    ratingNumeric: toNum(player.ratingNumeric),
    source: `FALLBACK_HTTP_${String(msg.statusCode || "ERR")}`,
  };
  return msg;
}

const client = msg.payload;
const levelLetter = getField(client, LK_FIELD_ID);
const levelNumeric = toNum(getField(client, NUM_FIELD_ID));

msg.payload = {
  clientId: player.clientId || null,
  phoneNorm: player.phoneNorm || null,
  name: player.name || null,
  rating: levelLetter || player.rating || null,
  ratingNumeric: levelNumeric ?? toNum(player.ratingNumeric),
  source: levelNumeric != null ? "VIVA_NUMERIC" : levelLetter ? "VIVA_LETTER" : "FALLBACK_EMPTY",
};
return msg;
