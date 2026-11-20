import { randomUUID } from "node:crypto";
import { calculateGameResultRating } from "../../scripts/lib/gameResultRating.mjs";
import { ClubError } from "./viva-booking.mjs";

const scorePart = value => Number.isInteger(value) && value >= 0 && value <= 25;
const eligible = (game, actor) => game.participants.some(player => player.id === actor.id && player.status === "CONFIRMED");
const ended = game => Date.parse(game.booking.timeToIso) <= Date.now();
const projection = (game, actor) => {
  const result = game.result ?? null;
  const canConfirm = result?.status === "PENDING_REVIEW" && result.confirmers.includes(actor.id);
  return {
    gameId: game.id, status: result?.status ?? "NOT_SUBMITTED", result,
    canSubmit: ended(game) && !result && game.invite.maxPlayers === 4 && game.participants.length === 4,
    viewerRole: result?.submittedBy?.id === actor.id ? "AUTHOR" : canConfirm ? "OPPONENT" : "PARTICIPANT",
    canConfirm, canDispute: canConfirm,
  };
};

export function createGameResults(db, client, tenantKey, stationId) {
  const games = db.collection("lk_games");
  const levels = db.collection("lk_player_levels");
  const events = db.collection("lk_game_rating_events");
  const scope = { tenantKey, status: "OPEN", "booking.studioId": stationId };
  const saveFilter = game => ({ _id: game._id, tenantKey, revision: game.revision });

  return async function updateResult(gameId, action, actor, payload = {}) {
    if (action === "state") {
      const game = await games.findOne({ id: gameId, ...scope });
      if (!game || !eligible(game, actor)) throw new ClubError(404, "GAME_NOT_FOUND", "Игра недоступна.");
      return projection(game, actor);
    }
    return client.withSession(session => session.withTransaction(async () => {
      const game = await games.findOne({ id: gameId, ...scope }, { session });
      if (!game || !eligible(game, actor)) throw new ClubError(404, "GAME_NOT_FOUND", "Игра недоступна.");
      const result = game.result;
      if (action === "submit") {
        if (result?.submittedBy?.id === actor.id && result.idempotencyKey === payload.idempotencyKey) return projection(game, actor);
        if (result || !ended(game) || game.invite.maxPlayers !== 4 || game.participants.length !== 4) {
          throw new ClubError(409, "RESULT_NOT_AVAILABLE", "Счёт можно внести после окончания игры с полным составом.");
        }
        if (typeof payload.idempotencyKey !== "string" || !/^[A-Za-z0-9:_-]{10,128}$/.test(payload.idempotencyKey)
          || !Array.isArray(payload.sets) || ![1, 2, 3].includes(payload.sets.length)
          || payload.sets.some(set => !scorePart(set?.left) || !scorePart(set?.right) || set.left === set.right)) {
          throw new ClubError(422, "INVALID_SCORE", "Проверьте счёт сетов.");
        }
        const roster = new Map(game.participants.map(player => [player.id, { id: player.id, name: player.name }]));
        const basePairing = [...roster.values()];
        const half = basePairing.length / 2;
        const sets = payload.sets.map(({ left, right }) => ({ left, right }));
        const pairings = sets.map((_, setIndex) => {
          const slots = Array.isArray(payload.setPairings)
            ? payload.setPairings.find(pairing => pairing?.setIndex === setIndex)?.teamSlots
            : undefined;
          if (slots !== undefined && !Array.isArray(slots)) {
            throw new ClubError(422, "INVALID_TEAMS", "Некорректный состав.");
          }
          const players = slots ? slots.map(slot => {
            const memberKey = typeof slot?.memberKey === "string" && slot.memberKey.startsWith("id:")
              ? slot.memberKey.slice(3) : null;
            return roster.get(slot?.id ?? slot?.clientId ?? memberKey);
          }) : basePairing;
          if (players.length !== roster.size || players.some(player => !player)
            || new Set(players.map(player => player.id)).size !== roster.size) {
            throw new ClubError(422, "INVALID_TEAMS", "Состав должен совпадать со списком участников игры.");
          }
          return { setIndex, teamA: players.slice(0, half), teamB: players.slice(half) };
        });
        const playedAgainstSubmitter = pairings.flatMap(pairing => (
          pairing.teamA.some(player => player.id === actor.id) ? pairing.teamB : pairing.teamA
        )).map(player => player.id);
        const scoreA = sets.filter(set => set.left > set.right).length;
        const now = new Date().toISOString();
        const next = {
          id: randomUUID(), idempotencyKey: payload.idempotencyKey, status: "PENDING_REVIEW",
          submittedAt: now, submittedBy: { id: actor.id, name: actor.name },
          scoreA, scoreB: sets.length - scoreA, sets, pairings, confirmers: [...new Set(playedAgainstSubmitter)],
        };
        await games.updateOne(saveFilter(game), { $set: { result: next, updatedAt: now }, $inc: { revision: 1 } }, { session });
        return projection({ ...game, result: next }, actor);
      }
      if (action === "confirm" && result?.status === "CONFIRMED" && result.confirmedBy?.id === actor.id) return projection(game, actor);
      if (result?.status !== "PENDING_REVIEW" || !result.confirmers.includes(actor.id)) {
        throw new ClubError(409, "RESULT_REVIEW_UNAVAILABLE", "Подтвердить или оспорить счёт может соперник.");
      }
      const now = new Date().toISOString();
      const next = { ...result, status: action === "dispute" ? "DISPUTED" : "CONFIRMED" };
      if (action === "confirm") {
        next.confirmedBy = { id: actor.id, name: actor.name };
        next.confirmedAt = now;
        if (game.settings.ratingGame && game.invite.maxPlayers === 4) {
          const ids = game.participants.map(player => player.id);
          const current = await levels.find({ _id: { $in: ids } }, { session }).toArray();
          if (current.length !== ids.length) {
            throw new ClubError(409, "ONBOARDING_REQUIRED", "Для начисления уровня все игроки должны пройти онбординг.");
          }
          const { formula, ratingImpact } = calculateGameResultRating({
            ratingFacts: { sets: result.sets, effectiveSetPairings: result.pairings },
          }, current.map(row => ({ id: row._id, ratingNumeric: row.level })));
          for (const impact of ratingImpact) {
            await levels.updateOne({ _id: impact.id }, { $set: { level: impact.after, updatedAt: now } }, { session });
            await events.insertOne({ _id: result.id + ":" + impact.id, gameId, tenantKey, formula, impact, createdAt: now }, { session });
          }
          next.ratingImpact = ratingImpact;
        }
      }
      await games.updateOne(saveFilter(game), { $set: { result: next, updatedAt: now }, $inc: { revision: 1 } }, { session });
      return projection({ ...game, result: next }, actor);
    }));
  };
}
