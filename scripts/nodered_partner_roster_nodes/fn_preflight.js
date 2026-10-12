const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};
const rosterTouched = ["participants", "waitlist"].some((key) => Object.prototype.hasOwnProperty.call(body, key));
if (!rosterTouched) return [msg, null];
const gameId = String(msg.req?.params?.gameId || "").trim();
if (!gameId) return [msg, null];
msg._partnerRosterPatch = { body, gameId };
msg.payload = [{ id: gameId, archived: { $ne: true } }, { limit: 2 }];
return [null, msg];
