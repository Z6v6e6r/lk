import crypto from "node:crypto";
import { BSON } from "mongodb";
import { collectTournamentIds, collectPublicationTournamentAliases, buildTimeForFriendsAtomicMembershipMutation } from "./timeForFriendsCommunityBackfill.mjs";
import { isTournamentFinalized } from "./tournamentFinalization.mjs";
import { loadTimeForFriendsProviderEnrollment } from "./timeForFriendsRuntimeRoster.mjs";

export const ENROLLMENT_VERSION = "published-tournament-enrollment-v1";
export const ENROLLMENT_COLLECTION = "lk_published_tournament_enrollments";
const array = (v) => Array.isArray(v) ? v : [];
const string = (v) => v == null ? "" : String(v).trim();
const uuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(string(v));
const phone = (v) => { const s = string(v).replace(/\D/g, ""); return s.length === 10 ? `7${s}` : s.length === 11 && s[0] === "8" ? `7${s.slice(1)}` : s; };
const ids = (r) => [...new Set([r?.clientId, r?.playerId, r?.userId, r?.uuid, r?.id].map(string).filter(uuid))];
const phones = (r) => [...new Set([r?.phoneNorm, r?.phone, r?.phoneNumber, r?.mobile].map(phone).filter(Boolean))];
const hash = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(BSON.EJSON.serialize(v, { relaxed: false }))).digest("hex");
const memberMatch = (r, p) => ids(r).includes(p.playerId) || Boolean(p.phoneNorm && phones(r).includes(p.phoneNorm));
export const enrollmentId = (t, c, p) => `${ENROLLMENT_VERSION}:${hash(`${t}|${c}|${p}`)}`;
export const trustedPublication = (p) => p?.kind === "TOURNAMENT" && p?.source === "ADMIN_PANEL" && p?.status === "PUBLISHED" && p?.archived !== true;
export function selectProviderBatch(candidates, limit, nowIso) {
  const offset = candidates.length ? (Math.floor(Date.parse(nowIso) / 900000) * limit) % candidates.length : 0;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, limit);
}

// Only explicit calendar dates; an edit timestamp never makes a tournament eligible.
export function publicationDate(post, tournament) {
  const raw = [post?.startAt, post?.details?.startsAt, post?.details?.publicTournament?.startsAt,
    tournament?.startsAt, tournament?.timeFrom, tournament?.params?.startsAt, tournament?.params?.timeFrom].filter(Boolean);
  const values = [...new Set(raw.map((v) => Date.parse(v)).filter(Number.isFinite))];
  if (values.length > 1) return { reason: "START_DATE_CONFLICT" };
  if (values.length === 1) return { at: values[0], basis: "START" };
  const ended = tournament?.params?.finishedAt || tournament?.params?.completedAt || tournament?.summary?.finishedAt || tournament?.summary?.completedAt;
  return ended && Number.isFinite(Date.parse(ended)) && isTournamentFinalized(tournament)
    ? { at: Date.parse(ended), basis: "FINISH_WITHOUT_START" } : { reason: "DATE_NOT_PROVEN" };
}

export function resolveEnrollmentPlayers(tournament, roster, states = []) {
  const final = isTournamentFinalized(tournament) && array(tournament?.standings).length > 0;
  if (!final && !roster) return { players: [], reasons: ["PROVIDER_ROSTER_REQUIRED"] };
  const rows = final ? tournament.standings : array(roster.participants);
  const players = [], reasons = [], seen = new Set();
  const canonical = new Map(states.filter((s) => s.clientId).map((s) => [string(s.clientId), s]));
  for (const row of rows) {
    if (!row || typeof row !== "object") { reasons.push("PLAYER_INVALID"); continue; }
    if (!final && (row.isCancelled === true || Number(row.spot) > Number(roster.maxParticipants))) continue;
    if (!final && (row.isCancelled !== false || !Number.isInteger(Number(row.spot)) || Number(row.spot) <= 0 || !(Number(roster.maxParticipants) > 0))) {
      reasons.push("ACTIVE_ROSTER_NOT_PROVEN"); continue;
    }
    const participant = final ? array(tournament.participants).find((p) => string(p.id) === string(row.id)) : null;
    const excluded = (p) => p?.isCancelled === true || p?.cancelled === true || p?.canceled === true || p?.isWaitlist === true
      || ["cancelled", "canceled", "waitlist", "waiting_list"].includes(string(p?.status || p?.state).toLowerCase());
    if (excluded(row) || excluded(participant)) continue;
    const keys = [...new Set([...ids(row), ...ids(participant)])];
    if (keys.length !== 1) { reasons.push("PLAYER_ID_AMBIGUOUS"); continue; }
    const playerId = keys[0];
    if (final && array(tournament.waitlist).some((p) => ids(p).includes(playerId))) continue;
    const capacity = Number(tournament?.maxParticipants ?? tournament?.maxClientsCount ?? tournament?.params?.maxParticipants ?? tournament?.params?.maxClientsCount);
    const spot = Number(participant?.spot ?? row.spot);
    if (final && capacity > 0 && Number.isFinite(spot) && spot > capacity) continue;
    if (seen.has(playerId)) { reasons.push("PLAYER_DUPLICATE"); continue; }
    seen.add(playerId);
    const ps = [...new Set([...phones(row), ...phones(participant), ...phones(canonical.get(playerId))])];
    if (ps.length > 1) { reasons.push("PLAYER_PHONE_CONFLICT"); continue; }
    players.push({ playerId, phoneNorm: ps[0] || null, playerName: string(participant?.name || row.name) || "Игрок" });
  }
  const collisions = new Set(players.filter((p) => p.phoneNorm && players.some((q) => q.playerId !== p.playerId && q.phoneNorm === p.phoneNorm)).map((p) => p.playerId));
  if (collisions.size) reasons.push("PLAYER_PHONE_COLLISION");
  return { players: players.filter((p) => !collisions.has(p.playerId)), reasons };
}

export function inspectMembership(community, player) {
  if (!community || community.archived === true) return "COMMUNITY_INACTIVE";
  if (array(community.bannedMembers).some((m) => memberMatch(m, player))) return "PLAYER_BANNED";
  for (const m of [...array(community.members), ...array(community.bannedMembers), ...array(community.pendingMembers)]) {
    if (player.phoneNorm && phones(m).includes(player.phoneNorm) && ids(m).length && !ids(m).includes(player.playerId)) return "MEMBER_IDENTITY_CONFLICT";
    if (!player.phoneNorm && !ids(m).length && phones(m).length) return "LEGACY_IDENTITY_UNRESOLVED";
  }
  if (array(community.members).some((m) => memberMatch(m, player))) return "ALREADY_MEMBER";
  return "MISSING";
}

export function buildPublishedEnrollmentPlan({ tournaments, publications, communities, states = [], rosters = new Map(), prior = [], fromIso, toIso, nowIso }) {
  const start = Date.parse(fromIso), end = Date.parse(toIso), now = Date.parse(nowIso);
  if (![start, end, now].every(Number.isFinite) || start >= end) throw new Error("Invalid enrollment period");
  const operations = [], issues = [], skipped = {}, groups = new Map();
  const increment = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const priorIds = new Set(prior.map((r) => string(r._id)));
  for (const post of publications) {
    if (!trustedPublication(post)) continue;
    const aliases = collectPublicationTournamentAliases(post);
    const matches = tournaments.filter((t) => collectTournamentIds(t).some((id) => aliases.includes(id)));
    if (matches.length > 1) { issues.push({ publicationId: string(post.id || post._id), reason: "TOURNAMENT_ALIAS_AMBIGUOUS" }); continue; }
    const tournament = matches[0];
    const date = publicationDate(post, tournament);
    if (!date.at) { issues.push({ publicationId: string(post.id || post._id), reason: date.reason }); continue; }
    if (date.at < start || date.at >= end) continue;
    if (date.at > now) increment("FUTURE_TOURNAMENT");
    const providerIds = [...new Set([post.details?.publicTournament?.exerciseId, post.details?.publicTournament?.sourceTournamentId, tournament?.exerciseId, tournament?.sourceTournamentId].map(string).filter(uuid))];
    if (providerIds.length > 1) { issues.push({ publicationId: string(post.id || post._id), reason: "PROVIDER_ALIAS_AMBIGUOUS" }); continue; }
    const tournamentId = providerIds[0] || string(tournament?.tournamentId || tournament?.id) || aliases.find(uuid);
    if (!tournamentId) { increment("TOURNAMENT_ID_MISSING"); continue; }
    let group = groups.get(tournamentId);
    if (!group) { group = { tournamentId, tournament, publications: [], date, providerId: providerIds[0] || (uuid(tournamentId) ? tournamentId : null) }; groups.set(tournamentId, group); }
    if (string(group.tournament?._id) !== string(tournament?._id) || group.date.at !== date.at) group.conflict = true;
    group.publications.push(post);
  }
  for (const group of groups.values()) {
    if (group.conflict) { issues.push({ tournamentId: group.tournamentId, reason: "GROUP_SOURCE_CONFLICT" }); continue; }
    const resolved = resolveEnrollmentPlayers(group.tournament, rosters.get(group.tournamentId), states);
    for (const reason of resolved.reasons) issues.push({ tournamentId: group.tournamentId, reason });
    // Any malformed roster identity invalidates this roster, not other tournaments.
    if (resolved.reasons.length) continue;
    for (const communityId of [...new Set(group.publications.map((p) => string(p.communityId)))]) {
      const community = communities.find((c) => string(c.id) === communityId);
      const posts = group.publications.filter((p) => string(p.communityId) === communityId);
      for (const player of resolved.players) {
        const operationId = enrollmentId(group.tournamentId, communityId, player.playerId);
        if (priorIds.has(operationId)) { increment("PREVIOUSLY_PROCESSED"); continue; }
        const status = inspectMembership(community, player);
        if (!["MISSING", "ALREADY_MEMBER"].includes(status)) { issues.push({ tournamentId: group.tournamentId, communityId, reason: status }); continue; }
        operations.push({ ...player, operationId, tournamentId: group.tournamentId, tournamentIds: [group.tournamentId], communityId,
          publicationIds: posts.map((p) => string(p.id || p._id)), status,
          source: { tournament: group.tournament, publications: posts, rosterFetchedAt: rosters.get(group.tournamentId)?.fetchedAt },
          joinSourceType: "PUBLISHED_TOURNAMENT_AUTO_ENROLLMENT", joinSourceVersion: ENROLLMENT_VERSION });
      }
    }
  }
  const bad = new Set();
  const phonePlayers = new Map(), playerPhones = new Map();
  for (const state of states) {
    const ph = phones(state)[0]; if (!ph || !uuid(state.clientId)) continue;
    const set = phonePlayers.get(ph) || new Set(); set.add(string(state.clientId)); phonePlayers.set(ph, set);
  }
  for (const op of operations) {
    if (!op.phoneNorm) continue;
    const ps = phonePlayers.get(op.phoneNorm) || new Set(); ps.add(op.playerId); phonePlayers.set(op.phoneNorm, ps);
    const phs = playerPhones.get(op.playerId) || new Set(); phs.add(op.phoneNorm); playerPhones.set(op.playerId, phs);
  }
  for (const op of operations) if (op.phoneNorm && (phonePlayers.get(op.phoneNorm)?.size > 1 || playerPhones.get(op.playerId)?.size > 1)) {
    bad.add(op.operationId); issues.push({ tournamentId: op.tournamentId, communityId: op.communityId, reason: "PLAN_IDENTITY_COLLISION" });
  }
  return { groups: [...groups.values()], operations: operations.filter((op) => !bad.has(op.operationId)), issues, skipped };
}

export async function runPublishedTournamentEnrollment({ client, db, fromIso, toIso, nowIso = new Date().toISOString(), dryRun = true, providerLimit = 20, providerLoader = loadTimeForFriendsProviderEnrollment, providerBudgetMs = 120000, beforeApply }) {
  const [tournaments, publications, communities, states, prior] = await Promise.all([
    db.collection("tournaments").find({}).toArray(),
    db.collection("lk_community_feed").find({ kind: "TOURNAMENT", archived: { $ne: true } }).toArray(),
    db.collection("lk_communities").find({ archived: { $ne: true } }).toArray(),
    db.collection("player_rating_state").find({}, { projection: { clientId: 1, phoneNorm: 1 } }).toArray(),
    db.collection(ENROLLMENT_COLLECTION).find({}, { projection: { _id: 1 } }).toArray(),
  ]);
  const inputs = { tournaments, publications, communities, states, prior, fromIso, toIso, nowIso };
  let plan = buildPublishedEnrollmentPlan(inputs);
  const rosters = new Map(), providerErrors = [], candidates = plan.groups.filter((g) => g.providerId && !(isTournamentFinalized(g.tournament) && array(g.tournament?.standings).length));
  // Rotate bounded provider reads so one problematic old tournament cannot starve later ones.
  const rotated = selectProviderBatch(candidates, providerLimit, nowIso);
  const providerStarted = Date.now(); let providerReads = 0;
  for (const group of rotated) {
    if (Date.now() - providerStarted >= providerBudgetMs) break;
    providerReads++;
    try { const roster = await providerLoader({ tournamentId: group.providerId }); rosters.set(group.tournamentId, { ...roster, fetchedAt: new Date().toISOString() }); }
    catch (error) { providerErrors.push({ tournamentId: group.tournamentId, reason: error.code || "PROVIDER_READ_FAILED" }); }
  }
  plan = buildPublishedEnrollmentPlan({ ...inputs, rosters });
  const summary = { enabled: true, dryRun, fromIso, toIso, observedAt: nowIso, tournaments: plan.groups.length, planned: new Set(plan.operations.filter((o) => o.status === "MISSING").map((o) => `${o.communityId}|${o.playerId}`)).size,
    alreadyMembers: plan.operations.filter((o) => o.status === "ALREADY_MEMBER").length, applied: 0, receipts: 0, providerReads,
    issues: [...plan.issues, ...providerErrors], skipped: plan.skipped, affectedCommunityIds: [] };
  if (dryRun) return summary;
  if (beforeApply) await beforeApply(plan);
  const affected = new Set();
  for (const operation of plan.operations) {
    const session = client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const audits = db.collection(ENROLLMENT_COLLECTION);
        if (await audits.findOne({ _id: operation.operationId }, { session })) return { applied: false, receipt: false };
        const currentPosts = await db.collection("lk_community_feed").find({ _id: { $in: operation.source.publications.map((p) => p._id) } }, { session }).toArray();
        if (currentPosts.length !== operation.source.publications.length || operation.source.publications.some((p) => hash(p) !== hash(currentPosts.find((c) => string(c._id) === string(p._id))))) throw new Error("Publication changed during enrollment");
        if (operation.source.tournament) {
          const t = await db.collection("tournaments").findOne({ _id: operation.source.tournament._id }, { session });
          if (hash(t) !== hash(operation.source.tournament)) throw new Error("Tournament changed during enrollment");
        }
        if (!(isTournamentFinalized(operation.source.tournament) && array(operation.source.tournament?.standings).length) && (!operation.source.rosterFetchedAt || Date.now() - Date.parse(operation.source.rosterFetchedAt) > 300000)) throw new Error("Provider roster expired before enrollment");
        const before = await db.collection("lk_communities").findOne({ id: operation.communityId }, { session });
        const status = inspectMembership(before, operation);
        if (!["MISSING", "ALREADY_MEMBER"].includes(status)) throw new Error(`Membership precondition: ${status}`);
        if (status === "MISSING") {
          const mutation = buildTimeForFriendsAtomicMembershipMutation(operation, nowIso);
          const result = await db.collection("lk_communities").updateOne({ ...mutation.filter, _id: before._id }, mutation.update, { session });
          if (result.modifiedCount !== 1) throw new Error("Membership CAS failed");
        }
        const after = await db.collection("lk_communities").findOne({ _id: before._id }, { session });
        if (!array(after.members).some((m) => ids(m).includes(operation.playerId)) && !array(after.members).some((m) => memberMatch(m, operation))) throw new Error("Membership readback failed");
        if (array(after.members).filter((m) => memberMatch(m, operation)).length !== 1 || after.memberCount !== after.members.length) throw new Error("Membership count readback failed");
        if (status === "MISSING" && !after.members.some((m) => m.id === operation.playerId && m.joinSource?.type === operation.joinSourceType)) throw new Error("Membership provenance readback failed");
        await audits.insertOne({ _id: operation.operationId, version: ENROLLMENT_VERSION, tournamentId: operation.tournamentId, communityId: operation.communityId,
          playerId: operation.playerId, publicationIds: operation.publicationIds, status: status === "MISSING" ? "APPLIED" : "ALREADY_MEMBER", createdAt: nowIso,
          ...(status === "MISSING" ? { before, afterSha256: hash(after) } : {}) }, { session });
        return { applied: status === "MISSING", receipt: true };
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000 });
      if (result?.applied) { summary.applied++; affected.add(operation.communityId); }
      if (result?.receipt) summary.receipts++;
      if (result?.applied) {
        const current = await db.collection("lk_communities").findOne({ id: operation.communityId });
        if (!current || current.memberCount !== array(current.members).length || array(current.members).filter((m) => memberMatch(m, operation)).length !== 1) throw new Error("Postcommit membership drift");
      }
    } catch (error) {
      // Each committed receipt is durable even if a later operation fails.
      summary.issues.push({ tournamentId: operation.tournamentId, communityId: operation.communityId,
        reason: /Publication changed|Tournament changed/.test(error.message) ? "SOURCE_DRIFT" : /expired/.test(error.message) ? "ROSTER_EXPIRED" : /Membership precondition/.test(error.message) ? "MEMBERSHIP_CHANGED" : "ENROLLMENT_EXECUTION_FAILED" });
      if (error.hasErrorLabel?.("UnknownTransactionCommitResult")) affected.add(operation.communityId);
    } finally { await session.endSession(); }
  }
  summary.affectedCommunityIds = [...affected];
  return summary;
}

// Recovery is deliberately conditional on the entire postimage, including unrelated fields.
export async function restorePublishedEnrollment({ client, db, operationId }) {
  const session = client.startSession();
  try { return await session.withTransaction(async () => {
    const audits = db.collection(ENROLLMENT_COLLECTION);
    const audit = await audits.findOne({ _id: operationId }, { session });
    if (!audit?.before || audit.status !== "APPLIED") throw new Error("Restorable enrollment receipt missing");
    const current = await db.collection("lk_communities").findOne({ _id: audit.before._id }, { session });
    if (hash(current) !== audit.afterSha256) throw new Error("Restore rejected community drift");
    await db.collection("lk_communities").replaceOne({ _id: current._id }, audit.before, { session });
    await audits.updateOne({ _id: operationId }, { $set: { status: "RESTORED", restoredAt: new Date().toISOString() } }, { session });
    return true;
  }, { writeConcern: { w: "majority" } }); } finally { await session.endSession(); }
}
