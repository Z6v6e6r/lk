import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";
import { ratingGradeFromNumeric } from "../../src/services/player-rating/ledger.ts";
import { createGameResults } from "./game-results.mjs";
import { ClubError, createVivaClient, reserveCourt, validateBookingSlot } from "./viva-booking.mjs";

export const club = JSON.parse(await readFile(new URL("./club.json", import.meta.url), "utf8"));
export const database = "lk1_novokuznetsk";
const tenantKey = club.tenantKey;
const namedCity = "Новокузнецк";
const tenantPath = "/novokuznetsk";
const codes = /^(?:[a-f0-9-]{36}|[a-f0-9]{32})$/i;
const offerUrl = club.siteOrigin + "/oferta";
const privacyUrl = club.siteOrigin + "/politcs";
const grades = ["D", "D+", "C", "C+", "B", "B+", "A"];
const tidy = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nonMember = () => new ClubError(404, "COMMUNITY_NOT_FOUND", "Сообщество недоступно.");
const notFound = () => new ClubError(404, "NOT_FOUND", "Раздел недоступен.");
function stripMongo(document) {
  const value = { ...document };
  delete value._id;
  delete value.creationKey;
  return value;
}
const member = actor => ({ id: actor.id, name: actor.name, status: "ACTIVE" });
const gamePlayer = actor => ({ id: actor.id, name: actor.name, source: "INVITE_LINK", status: "CONFIRMED" });

async function readJson(req) {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new ClubError(415, "JSON_REQUIRED", "Требуется JSON.");
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 48_000) throw new ClubError(413, "BODY_TOO_LARGE", "Слишком большой запрос.");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* Invalid JSON. */ }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClubError(400, "INVALID_JSON", "Некорректный запрос.");
  }
  return value;
}

export function createClubApi({ client, viva = createVivaClient(club), consentVersion, bookEnabled = false }) {
  const db = client.db(database);
  const collection = name => db.collection(name);
  const games = collection("lk_games");
  const levels = collection("lk_player_levels");
  const communities = collection("lk_communities");
  const bookingLedger = collection("lk_club_booking_operations");
  const gameResult = createGameResults(db, client, tenantKey, club.stationId);
  const gameScope = { tenantKey, "booking.studioId": club.stationId };
  const visibleCommunities = actor => ({
    tenantKey, archived: false,
    $or: [{ visibility: "OPEN" }, { "members.id": actor.id }],
  });
  const ownCommunityView = (community, actor) => {
    const data = stripMongo(community);
    if (community.members.some(item => item.id === actor.id && item.status === "ACTIVE")) return data;
    return { ...data, inviteCode: undefined, members: community.members.filter(item => item.id === actor.id) };
  };
  const requireMember = async (communityId, actor) => {
    const community = await communities.findOne({ id: communityId, tenantKey, archived: false,
      members: { $elemMatch: { id: actor.id, status: "ACTIVE" } },
    });
    if (!community) throw nonMember();
    return community;
  };

  async function route(req, url) {
    const { method } = req;
    const path = url.pathname;
    if (method === "GET" && path === "/healthz") {
      await db.command({ ping: 1 });
      return { ok: true, tenantKey, bookingEnabled: bookEnabled };
    }
    if (method === "GET" && path === "/lk/onboarding/stations") return {
      stations: [{ id: club.stationId, name: club.stationName, city: namedCity, timeZone: club.timeZone,
        isActive: true, masterServiceId: club.masterServiceId, preferredSubServiceId: club.preferredSubServiceId,
        subServiceIds: club.subServiceIds }],
    };
    if (method === "GET" && path === "/lk/games" && ["find", "true"].includes(url.searchParams.get("public"))) {
      const station = url.searchParams.get("stationId") || url.searchParams.get("studioId");
      if (station && station !== club.stationId) throw notFound();
      const date = url.searchParams.get("date");
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit")) || 12)));
      const offset = Math.min(10000, Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0)));
      const rows = await games.find({ ...gameScope, status: "OPEN", "settings.isPrivate": false,
        $expr: { $gt: [{ $toDate: "$booking.timeToIso" }, new Date()] },
        ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { "booking.date": date } : {}) },
      { projection: { _id: 0, "booking.bookingIds": 0, "booking.exerciseId": 0, "booking.vivaExerciseId": 0,
        result: 0, "payment.bookingIds": 0, bookingRef: 0, "organizer.id": 0, participants: 0 } })
        .sort({ "booking.date": 1, "booking.timeFrom": 1 }).skip(offset).limit(limit + 1).toArray();
      return { games: rows.slice(0, limit), total: offset + rows.length };
    }

    const actor = await viva.profile(req.headers.authorization);
    if (method === "GET" && path === "/lk/onboarding/level") {
      const record = await levels.findOne({ _id: actor.id });
      return { level: record?.level ?? null, grade: record ? ratingGradeFromNumeric(record.level) : null };
    }
    if (method === "POST" && path === "/lk/onboarding/level") {
      const data = await readJson(req);
      const level = typeof data.levelNumeric === "number" || typeof data.levelNumeric === "string"
        ? Number(String(data.levelNumeric).trim().replace(",", ".")) : NaN;
      if (data.clientId !== actor.id || data.gameId || data.eventId || data.changedById
        || !Number.isFinite(level) || level < 1 || level > 7) {
        throw new ClubError(422, "INVALID_LEVEL", "Не удалось сохранить исходный уровень.");
      }
      await levels.updateOne({ _id: actor.id }, { $setOnInsert: { level, initialLevel: level,
        source: "ONBOARDING", createdAt: new Date().toISOString() } }, { upsert: true });
      const saved = await levels.findOne({ _id: actor.id });
      return { ok: true, level: saved.level, grade: ratingGradeFromNumeric(saved.level) };
    }
    if (method === "POST" && path === "/lk/analytics/auth-consents") {
      const data = await readJson(req);
      const valid = data.schemaVersion === 1 && data.documentSetVersion === consentVersion
        && ["sms", "vkid", "yandex"].includes(data.authMethod)
        && Array.isArray(data.documents) && data.documents.length === 2
        && [["public-offer", offerUrl], ["personal-data-policy", privacyUrl]].every(([id, url]) =>
          data.documents.some(doc => doc.id === id && doc.url === url && doc.version === consentVersion && doc.accepted === true));
      if (!valid) throw new ClubError(422, "INVALID_CONSENT", "Не удалось подтвердить согласие.");
      const key = hash([actor.id, consentVersion, data.authMethod, data.acceptedAtClient ?? null]);
      await collection("lk_auth_consents").updateOne({ _id: key }, {
        $setOnInsert: { actorId: actor.id, consentVersion, authMethod: data.authMethod, acceptedAt: new Date() },
      }, { upsert: true });
      return { ok: true };
    }

    if (method === "POST" && path === "/lk/venue-bookings") {
      if (!bookEnabled) throw new ClubError(503, "BOOKING_DISABLED", "Бронирование пока недоступно.");
      const input = await readJson(req);
      const slot = validateBookingSlot(club, input);
      if (typeof input.publishGame !== "boolean") throw new ClubError(422, "BOOKING_MODE_REQUIRED", "Выберите бронь или игру.");
      const maxPlayers = slot.serviceId === club.preferredSubServiceId ? 4 : 2;
      if (input.publishGame && input.ratingGame && maxPlayers !== 4) {
        throw new ClubError(422, "RATING_DOUBLES_ONLY", "Уровень начисляется за игры 2 на 2.");
      }
      if (input.publishGame && input.ratingGame && !await levels.findOne({ _id: actor.id })) {
        throw new ClubError(409, "ONBOARDING_REQUIRED", "Пройдите онбординг для рейтинговой игры.");
      }
      const booking = await reserveCourt({ ledger: bookingLedger, viva, actor, slot });
      if (!input.publishGame) return { bookingId: booking.bookingId };
      const now = new Date().toISOString();
      const id = randomUUID();
      const date = slot.timeFrom.slice(0, 10);
      const game = {
        id, tenantKey, revision: 1, status: "OPEN", createdAt: now, updatedAt: now,
        organizer: { id: actor.id, name: actor.name },
        booking: {
          studioId: club.stationId, studioName: club.stationName, roomId: slot.roomId,
          roomName: slot.roomName, date, timeFrom: slot.timeFrom.slice(11, 16), timeTo: slot.timeTo.slice(11, 16),
          timeFromIso: slot.timeFrom, timeToIso: slot.timeTo, durationMinutes: slot.duration,
          masterServiceId: club.masterServiceId, subServiceIds: [slot.serviceId],
          bookingIds: [booking.bookingId], exerciseId: booking.exerciseId, vivaExerciseId: booking.exerciseId,
        },
        payment: { paid: false, paymentUrl: null, paymentMethod: "ON_PLACE" },
        settings: { isPrivate: input.isPrivate === true, ratingGame: input.ratingGame === true, payMode: "self" },
        invite: { maxPlayers, waitlistEnabled: false },
        participants: [{ ...gamePlayer(actor), source: "ORGANIZER" }], waitlist: [],
        metadata: { gameTitle: tidy(input.title, 100), source: "novokuznetsk_on_place", gameFormat: maxPlayers === 4 ? "doubles" : "singles" },
      };
      const saved = await games.findOneAndUpdate({ bookingRef: booking.key, ...gameScope }, {
        $setOnInsert: { ...game, _id: booking.key, bookingRef: booking.key },
      }, { upsert: true, returnDocument: "after" });
      return { bookingId: booking.bookingId, game: stripMongo(saved) };
    }

    if (method === "GET" && ["/lk/games", "/lk/games/by-phone"].includes(path)) {
      const rows = await games.find({ ...gameScope, "participants.id": actor.id })
        .sort({ "booking.date": -1 }).limit(100).toArray();
      return { games: rows.map(stripMongo), identityFiltered: true, total: rows.length };
    }
    const gameMatch = path.match(/^\/lk\/games\/([a-f0-9-]{36})(?:\/(join|result\/(?:state|submit|confirm|dispute)))?$/i);
    if (gameMatch) {
      const [, id, action] = gameMatch;
      if (action?.startsWith("result/")) {
        const name = action.split("/")[1];
        if (method === "GET" && name === "state") return gameResult(id, name, actor);
        if (method === "POST" && name !== "state") return gameResult(id, name, actor, await readJson(req));
        throw notFound();
      }
      const scope = { ...gameScope, id, status: "OPEN" };
      const game = await games.findOne(scope);
      if (!game) throw notFound();
      if (!action && method === "GET") {
        const visible = stripMongo(game);
        if (game.participants.some(player => player.id === actor.id)) return { game: visible };
        return { game: { ...visible, result: undefined,
          booking: { ...visible.booking, bookingIds: undefined, exerciseId: undefined, vivaExerciseId: undefined } } };
      }
      if (action === "join" && method === "POST") {
        if (game.participants.some(player => player.id === actor.id)) return { game: stripMongo(game) };
        if (game.settings.ratingGame && !await levels.findOne({ _id: actor.id })) {
          throw new ClubError(409, "ONBOARDING_REQUIRED", "Пройдите онбординг перед вступлением в рейтинговую игру.");
        }
        const joined = await games.findOneAndUpdate({ ...scope, "participants.id": { $ne: actor.id },
          $expr: { $and: [
            { $gt: [{ $toDate: "$booking.timeFromIso" }, new Date()] },
            { $lt: [{ $size: "$participants" }, "$invite.maxPlayers"] },
          ] },
        }, { $push: { participants: gamePlayer(actor) }, $inc: { revision: 1 } }, { returnDocument: "after" });
        if (!joined) throw new ClubError(409, "GAME_FULL", "В игре нет свободных мест или запись завершена.");
        return { game: stripMongo(joined) };
      }
      throw notFound();
    }

    if (method === "GET" && path === "/lk/communities") {
      const rows = await communities.find(visibleCommunities(actor)).sort({ createdAt: -1 }).limit(100).toArray();
      return { communities: rows.map(row => ownCommunityView(row, actor)), connections: [] };
    }
    if (method === "POST" && path === "/lk/communities") {
      const data = await readJson(req);
      const name = tidy(data.name, 80);
      const description = tidy(data.description, 500);
      const visibility = data.visibility;
      if (!name || !description || !["OPEN", "CLOSED"].includes(visibility) || data.logoUrl || data.logoThumbUrl || data.joinRule === "MODERATED") {
        throw new ClubError(422, "INVALID_COMMUNITY", "Укажите название и описание сообщества.");
      }
      const stamp = new Date().toISOString();
      const creationKey = hash([actor.id, name.toLowerCase()]);
      const community = await communities.findOneAndUpdate({ _id: creationKey, tenantKey }, { $setOnInsert: {
        id: randomUUID(), tenantKey, name, description, city: namedCity, type: "FRIENDS", visibility,
        rules: tidy(data.rules, 1000), joinRule: visibility === "CLOSED" || data.joinRule === "INVITE_ONLY" ? "INVITE_ONLY" : "INSTANT",
        minimumLevel: grades.includes(data.minimumLevel) ? data.minimumLevel : null,
        focusTags: (Array.isArray(data.focusTags) ? data.focusTags : []).slice(0, 6).map(item => tidy(item, 28)).filter(Boolean),
        inviteCode: randomBytes(16).toString("hex"), members: [{ ...member(actor), role: "OWNER", joinedAt: stamp }],
        ownerId: actor.id, archived: false, createdAt: stamp, memberCount: 1,
      } }, { upsert: true, returnDocument: "after" });
      return { community: stripMongo(community), message: "Сообщество создано." };
    }
    if (method === "POST" && path === "/lk/communities/join-by-invite") {
      const data = await readJson(req);
      if (!codes.test(data.inviteCode ?? "")) throw nonMember();
      return joinCommunity({ inviteCode: data.inviteCode, tenantKey, archived: false }, actor);
    }
    const communityMatch = path.match(/^\/lk\/communities\/([a-f0-9-]{36})(?:\/(feed|messages|ranking|rating|events|add-member))?$/i);
    if (communityMatch) {
      const [, id, action] = communityMatch;
      if (method === "GET" && !action) {
        const community = await communities.findOne({ ...visibleCommunities(actor), id });
        if (!community) throw nonMember();
        return { community: ownCommunityView(community, actor) };
      }
      if (method === "POST" && action === "add-member") {
        return joinCommunity({ id, tenantKey, visibility: "OPEN", joinRule: "INSTANT", archived: false }, actor);
      }
      if (method === "GET" && action) {
        await requireMember(id, actor);
        if (action === "feed") return { posts: [] };
        if (action === "messages") return { messages: [] };
        if (action === "events") return { events: [] };
        if (action === "ranking" || action === "rating") return { ranking: null, players: [] };
      }
    }
    throw notFound();
  }

  async function joinCommunity(scope, actor) {
    const existing = await communities.findOne(scope);
    if (!existing) throw nonMember();
    const present = existing.members.find(item => item.id === actor.id);
    if (present) return { community: ownCommunityView(existing, actor), membershipStatus: present.status };
    if (existing.minimumLevel) {
      const row = await levels.findOne({ _id: actor.id });
      if (!row || grades.indexOf(ratingGradeFromNumeric(row.level)) < grades.indexOf(existing.minimumLevel)) {
        throw new ClubError(403, "COMMUNITY_LEVEL_REQUIRED", "Уровень пока не соответствует условиям сообщества.");
      }
    }
    const status = "ACTIVE";
    const joined = await communities.findOneAndUpdate({ _id: existing._id, tenantKey, "members.id": { $ne: actor.id },
      $expr: { $lt: [{ $size: "$members" }, 500] },
    }, { $push: { members: { ...member(actor), role: "MEMBER", status, joinedAt: new Date().toISOString() } },
      $inc: { memberCount: status === "ACTIVE" ? 1 : 0 } }, { returnDocument: "after" });
    const current = joined ?? await communities.findOne({ _id: existing._id, tenantKey });
    if (!current?.members.some(item => item.id === actor.id)) throw new ClubError(409, "COMMUNITY_FULL", "В сообществе нет свободных мест.");
    return { community: ownCommunityView(current, actor), membershipStatus: status };
  }

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const write = (status, value) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store", vary: "Origin",
        ...(origin === club.siteOrigin ? { "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type" } : {}),
      });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      if (origin && origin !== club.siteOrigin) throw new ClubError(403, "ORIGIN_FORBIDDEN", "Недопустимый адрес сайта.");
      const url = new URL(req.url, "http://127.0.0.1");
      if (!url.pathname.startsWith(tenantPath + "/")) throw notFound();
      if (req.method === "OPTIONS") return write(204);
      url.pathname = url.pathname.slice(tenantPath.length);
      write(200, await route(req, url));
    } catch (error) {
      if (error instanceof ClubError) return write(error.status, { code: error.code, message: error.message, error: error.message });
      console.error("club-api error", error?.name || "Error", Number(error?.code) || "");
      write(503, { code: "CLUB_UNAVAILABLE", message: "Сервис клуба временно недоступен." });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const uri = process.env.NVK_MONGO_URI || "";
  const consentVersion = process.env.NVK_CONSENT_VERSION || "";
  const port = Number(process.env.NVK_PORT || "18429");
  if (!/^mongodb:\/\/lk1_novokuznetsk_backend:[^/@]+@127\.0\.0\.1:[1-9]\d{3,4}\/lk1_novokuznetsk$/.test(uri)
    || !/^[A-Za-z0-9._-]{1,64}$/.test(consentVersion) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid club runtime configuration");
  }
  const client = new MongoClient(uri, { directConnection: true, maxPoolSize: 12, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(database);
  const hello = await db.command({ hello: 1 });
  if (!hello.isWritablePrimary || !hello.setName) throw new Error("A writable club MongoDB replica set is required");
  await createClubApi({ client, consentVersion, bookEnabled: process.env.NVK_BOOKING_ENABLED === "1" }).listen(port, "127.0.0.1");
}
