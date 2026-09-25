import { createPublicPhoneData } from "../../src/utils/publicPhoneData.js";

export function createServerPhonePrivacy(crypto, key) {
  // No source/default key: an unkeyed phone digest is enumerable offline.
  return createPublicPhoneData((phone, scope) => {
    if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) {
      throw new Error("PUBLIC_IDENTITY_KEY_NOT_CONFIGURED");
    }
    return "pp_" + crypto.createHmac("sha256", key)
      .update(JSON.stringify(["lk-public-phone-v1", scope, phone]))
      .digest("hex").slice(0, 32);
  });
}

export function phonePrivacyPrelude() {
  return `const createPublicPhoneData = ${createPublicPhoneData.toString()};\n`
    + `const createServerPhonePrivacy = ${createServerPhonePrivacy.toString()};\n`
    + 'const privacy = createServerPhonePrivacy(crypto, env.get("LK_PUBLIC_IDENTITY_HMAC_KEY"));\n';
}

export const privacyErrorSource = `
msg.statusCode = error.message === "PUBLIC_IDENTITY_UNKNOWN" ? 409 : 503;
msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
msg.payload = { error: msg.statusCode === 409 ? "Обновите данные перед сохранением" : "Данные временно недоступны", code: error.message === "PUBLIC_IDENTITY_UNKNOWN" ? "PUBLIC_IDENTITY_UNKNOWN" : "PUBLIC_IDENTITY_UNAVAILABLE" };
`;

export function responsePrivacySource() {
  return phonePrivacyPrelude() + `
try {
  if (Buffer.isBuffer(msg.payload) || typeof msg.payload !== "object" || msg.payload === null) return msg;
  const path = String(msg.req?.route?.path || msg.req?.path || msg.req?.url || "");
  const gameId = msg.req?.params?.gameId || msg.payload?.gameId;
  const communityId = msg.req?.params?.communityId || msg.payload?.communityId;
  const tournamentId = msg.req?.query?.tournamentId || msg.req?.body?.tournamentId || msg.payload?.tournamentId;
  const context = msg._chatActor || msg._resultActor || msg._chatGet || msg._chatList || msg._chat
    || msg._communityChat || msg._communityFeedThread || msg._communityFeed || msg._communityRatingCtx || msg._communityGet || msg._communityList
    || msg._communityMemberManage?.actor || msg._communityFeedComment?.member || msg._communityChatPost?.member
    || msg._communityPost?.verifiedActor || msg._communityUpdate?.actor || msg._communityJoin?.member
    || msg._communityFeedArchive?.member || msg._communityFeedReaction?.member || {};
  const viewer = { id: context.clientId || context.id || context.senderId || null, phone: context.phoneNorm || context.phone || context.senderPhone || null };
  const kind = path.includes("/tournaments/americano") ? "tournament" : /\\/(ranking|rating)$/.test(path) ? "rating" : path.includes("/chat") ? "chat" : path.includes("/lk/games") ? "game" : "generic";
  const scope = msg._phonePrivacyScope || (communityId ? "community:legacy:" + communityId : gameId ? "game:legacy:" + gameId : tournamentId ? "tournament:legacy:" + tournamentId : "legacy");
  const references = {};
  let payload = msg.payload;
  // Successful split responses and confirmed replays contain provider references, not
  // person identities. Numeric payment tokens must remain usable by the client.
  // Keep the exception at these exact POST routes and root fields; nested game,
  // participant, metadata and error fields still use the normal projection.
  const splitRoute = /^\\/lk\\/games\\/(?:split\\/create|[^/?]+\\/split\\/join)$/.test(path);
  const confirmedReplay = msg.statusCode === 200 && payload.state === "CONFIRMED"
    && msg._subscriptionBooking?.lk1IngressReplay === true && msg._subscriptionBooking?.lk1;
  const checkout = msg._subscriptionBooking?.lk1?.checkout;
  const confirmedCheckout = path === "/lk/subscription-bookings" && msg.statusCode === 200 && payload.state === "CONFIRMED"
    && msg._subscriptionBooking?.step === "lk1_checkout_saved" && checkout
    && payload.paymentUrl === checkout.paymentUrl && payload.transactionId === checkout.transactionId;
  if (String(msg.req?.method || "").toUpperCase() === "POST" && !Array.isArray(payload)
    && ((splitRoute && msg.statusCode === 201) || ((splitRoute || path === "/lk/subscription-bookings") && confirmedReplay) || confirmedCheckout)) {
    payload = { ...payload };
    for (const field of ["bookingId", "transactionId", "productId", "exerciseId"]) {
      if (typeof payload[field] === "string" || (typeof payload[field] === "number" && Number.isFinite(payload[field]))) {
        references[field] = payload[field];
        delete payload[field];
      }
    }
    if (typeof payload.paymentUrl === "string" && /^https?:\\/\\/[^/?#\\s]+(?:[/?#][^\\s]*)?$/i.test(payload.paymentUrl)) {
      references.paymentUrl = payload.paymentUrl.replace(/([?&][^=&#]*(?:phone|mobile|telephone|msisdn)[^=&#]*=)[^&#]*/gi, "$1[redacted]");
      delete payload.paymentUrl;
    }
  }
  msg.payload = Object.assign(privacy.project(payload, { scope, viewer, kind }), references);
  msg.headers = { ...(msg.headers || {}), "Cache-Control": "no-store" };
  return msg;
} catch (error) { ${privacyErrorSource} return msg; }
`;
}

export function tournamentExportPrivacySource() {
  return phonePrivacyPrelude() + `
try {
  msg.payload = privacy.project(msg.payload, { kind: "tournament" });
  return [msg, null];
} catch (error) { ${privacyErrorSource} return [null, msg]; }
`;
}

export function tournamentRestorePrivacySource(mode) {
  if (!["save", "results"].includes(mode)) throw new Error("Unknown tournament privacy mode");
  return phonePrivacyPrelude() + `
try {
  const stored = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
  const input = ${mode === "save" ? "msg._phonePrivacyCommand" : "msg.req?.body"} || {};
  const scope = "tournament:" + (stored?.tenantKey || input.tenantKey || "legacy") + ":" + (stored?.tournamentId || input.tournamentId);
  const command = privacy.restore(input, stored, scope);
  const preserveContacts = (next, previous) => {
    if (!next || !previous) return next;
    const restored = { ...next };
    ["phone", "phoneNorm", "phoneNumber", "mobile"].forEach((field) => { if (restored[field] == null && previous[field] != null) restored[field] = previous[field]; });
    return restored;
  };
  if (stored && Array.isArray(command.participants)) {
    command.participants = command.participants.map((participant) => {
      const previous = (stored.participants || []).find((row) => String(row.id || row.phone || "") === String(participant.id || ""));
      if (!previous) return participant;
      return preserveContacts(participant, previous);
    });
  }
  if (stored?.organizer && command.organizer && String(stored.organizer.id || "") === String(command.organizer.id || "")) command.organizer = preserveContacts(command.organizer, stored.organizer);
  msg._phonePrivacyScope = scope;
  ${mode === "save" ? "msg.payload = command; delete msg._phonePrivacyCommand;" : "msg.req.body = command;"}
  return [msg, null];
} catch (error) { ${privacyErrorSource} return [null, msg]; }
`;
}

export function communityRestorePrivacySource(mode = "member") {
  if (!["member", "rating"].includes(mode)) throw new Error("Unknown community privacy mode");
  return phonePrivacyPrelude() + `
try {
  const stored = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
  if (!stored?.id) return [msg, null];
  const scope = "community:legacy:" + stored.id;
  // Only the operation's target is a public reference. Never resolve the caller,
  // actor or any other field used by the existing authorization checks.
  ${mode === "member" ? `
  if (msg.req?.body?.member) msg.req.body.member = privacy.restore(msg.req.body.member, stored, scope);
  if (msg._communityMemberManage?.member) msg._communityMemberManage.member = privacy.restore(msg._communityMemberManage.member, stored, scope);
  ` : `
  if (msg.req?.params?.playerId) msg.req.params.playerId = privacy.restore({ playerId: msg.req.params.playerId }, stored, scope).playerId;
  if (msg._communityPlayerRating?.playerId) msg._communityPlayerRating.playerId = privacy.restore({ playerId: msg._communityPlayerRating.playerId }, stored, scope).playerId;
  `}
  return [msg, null];
} catch (error) { ${privacyErrorSource} return [null, msg]; }
`;
}

export function resultRestorePrivacySource(mode) {
  if (!["submit", "session"].includes(mode)) throw new Error("Unknown result privacy mode");
  return phonePrivacyPrelude() + `
try {
  const stored = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
  if (!stored) return [msg, null];
  const context = ${mode === "submit" ? "msg._resultSubmit" : "msg._resultSessionPatch"};
  if (!context) return [msg, null];
  const scope = "game:legacy:" + (stored.gameId || stored.id || context.gameId);
  const references = [];
  const oldPublicKey = (value) => {
    if (/^rm_[a-z0-9]+$/i.test(value)) return value;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619);
    }
    return "rm_" + (hash >>> 0).toString(36);
  };
  const collect = (value, key = "") => {
    if (Array.isArray(value)) return value.forEach((item) => collect(item, key));
    if (!value || typeof value !== "object") return;
    const explicit = value.memberKey || value.playerKey || value.participantKey || value.rosterMemberKey;
    if (explicit || ["members", "participants", "waitlist", "organizer"].includes(key)) {
      const id = value.id || value.clientId || value.uuid || value.userId || value.playerId;
      const phone = privacy.phoneIdentity(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
      const memberKey = explicit || (id ? "id:" + id : phone ? "phone:" + phone : null);
      if (memberKey) references.push({ memberKey: oldPublicKey(String(memberKey)) });
    }
    for (const [field, child] of Object.entries(value)) collect(child, field);
  };
  collect(stored);
  const mapping = { stored, references };
  // Restore only lineup targets. The authenticated actor, session revision,
  // idempotency key, scores and all permission inputs remain untouched.
  const pairings = ${mode === "submit" ? "context.setPairings" : "context.draftPairings"};
  if (Array.isArray(pairings)) {
    const restored = pairings.map((pairing) => ({ ...pairing,
      ...(Array.isArray(pairing.teamSlots) ? { teamSlots: privacy.restore({ teamSlots: pairing.teamSlots }, mapping, scope).teamSlots } : {}) }));
    ${mode === "submit" ? "context.setPairings" : "context.draftPairings"} = restored;
  }
  ${mode === "submit" ? `
  if (context.rosterSnapshot && typeof context.rosterSnapshot === "object") {
    for (const field of ["initialTeamMemberKeys", "initialTeamSlots"]) {
      if (context.rosterSnapshot[field]) context.rosterSnapshot[field] = privacy.restore({ [field]: context.rosterSnapshot[field] }, mapping, scope)[field];
    }
  }` : ""}
  return [msg, null];
} catch (error) { ${privacyErrorSource} return [null, msg]; }
`;
}
