const statusCode = Number(msg.statusCode) || 0;
const parse = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const body = parse(msg.payload);
const participants = Array.isArray(body?.participants) ? body.participants : null;
if (msg.error || statusCode < 200 || statusCode >= 300 || !participants) {
  msg.statusCode = 502;
  msg.headers = {};
  msg.payload = { error: "Participants temporarily unavailable" };
  return [null, msg];
}

const fetchCapacity = Math.max(
  1,
  Math.min(Math.floor(Number(msg.participantFetchCapacity ?? msg.participantSize ?? msg.participantResponseSize) || 100), 200),
);
const seen = new Set();
const splitName = (value) => {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
};
const items = [];
for (const [index, participant] of participants.entries()) {
  if (!participant || typeof participant !== "object" || Array.isArray(participant)) continue;
  const id = String(participant.id || "").trim();
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const name = splitName(participant.name);
  const level = String(participant.levelLabel ?? "").trim();
  const avatar = String(participant.avatarUrl ?? participant.avatar ?? participant.photo ?? "").trim();
  items.push({
    id,
    spot: Number.isInteger(Number(participant.spot)) && Number(participant.spot) > 0
      ? Number(participant.spot)
      : index + 1,
    isCancelled: false,
    client: {
      id,
      firstName: name.firstName,
      lastName: name.lastName,
      middleName: null,
      photo: avatar || null,
    },
    rating: level || null,
    ratingSource: level ? "cup" : "cup_unrated",
    paymentStatus: participant.paymentStatus ?? null,
    status: participant.status ?? "REGISTERED",
  });
  if (items.length >= fetchCapacity) break;
}

msg.statusCode = 200;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "x-lk-participants-source": "cup",
};
msg.payload = items;
return [msg, null];
