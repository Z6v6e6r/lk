const LK_FIELD_ID = "f9790818-25fd-4b73-a781-79c02720727d";
const NUM_FIELD_ID = "eabfe27b-3f72-4496-9185-1a2ec6e6465e";
const clientResponse = msg.payload;
const participant = msg.participant || {};
const getField = (id) => clientResponse?.customFields?.find((field) => field.id === id)?.value?.[0];
const letter = getField(LK_FIELD_ID);
const numericRaw = getField(NUM_FIELD_ID);
const numericValue = Number(String(numericRaw ?? "").replace(",", "."));
const numeric = Number.isFinite(numericValue) ? numericValue.toFixed(5) : null;
const rating = numeric || letter || null;
const ratingSource = numeric ? "numeric" : letter ? "letter" : "unavailable";

if (msg.statusCode >= 200 && msg.statusCode < 300 && participant?.client?.id) {
  const CACHE_KEY = "lkTournamentParticipantClientRatingCacheV2";
  const cache = flow.get(CACHE_KEY) || {};
  cache[participant.client.id] = { at: Date.now(), rating, ratingSource };
  const entries = Object.entries(cache);
  if (entries.length > 2_000) {
    entries
      .sort(([, left], [, right]) => Number(left?.at || 0) - Number(right?.at || 0))
      .slice(0, entries.length - 2_000)
      .forEach(([key]) => delete cache[key]);
  }
  flow.set(CACHE_KEY, cache);
}

msg.payload = { ...participant, rating, ratingSource };
return msg;
