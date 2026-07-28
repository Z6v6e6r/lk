const asArray = (value) => (Array.isArray(value) ? value : []);
const uniq = (values) => Array.from(new Set(asArray(values).filter(Boolean)));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const normalizeMember = (value, fallbackName, bucket) => {
  if (!value || typeof value !== "object") return null;
  const clientId = toStr(value.clientId || value.id || value.uuid || value.userId || value.playerId);
  const phoneNorm = normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
  const explicitMemberKey = toStr(value.memberKey || value.playerKey || value.participantKey || value.rosterMemberKey);
  const memberKey = explicitMemberKey
    || (clientId ? `id:${clientId}` : null)
    || (phoneNorm ? `phone:${phoneNorm}` : null);
  if (!memberKey) return null;
  return {
    memberKey,
    clientId,
    id: clientId,
    phoneNorm,
    name: toStr(value.name || value.fullName || value.title || value.displayName) || fallbackName || "Игрок",
    bucket: toStr(value.bucket || value.source || bucket) || bucket || "participant",
    photo: toStr(value.photo || value.avatar || value.imageUrl),
    rating: value.rating ?? null,
    ratingNumeric: Number.isFinite(Number(value.ratingNumeric)) ? Number(value.ratingNumeric) : null,
    status: toStr(value.status),
    role: toStr(value.role),
  };
};

const mergeMember = (current, incoming) => ({
  ...current,
  clientId: current.clientId || incoming.clientId,
  id: current.id || incoming.id,
  phoneNorm: current.phoneNorm || incoming.phoneNorm,
  name: current.name || incoming.name,
  bucket: current.bucket === "waitlist" && incoming.bucket !== "waitlist"
    ? incoming.bucket
    : current.bucket,
  photo: current.photo || incoming.photo,
  rating: current.rating ?? incoming.rating,
  ratingNumeric: current.ratingNumeric ?? incoming.ratingNumeric,
  status: current.status || incoming.status,
  role: current.role || incoming.role,
});

const snapshotMembers = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return [];
  if (asArray(snapshot.members).length > 0) return snapshot.members;
  if (asArray(snapshot.playerPool).length > 0) return snapshot.playerPool;
  return asArray(snapshot.allPlayers);
};

const resolveMember = (members, value) => {
  const raw = typeof value === "string" || typeof value === "number" ? toStr(value) : null;
  const normalized = value && typeof value === "object"
    ? normalizeMember(value, null, value.bucket || "participant")
    : null;
  const memberKey = normalized?.memberKey || raw;
  const clientId = normalized?.clientId || raw;
  const phoneNorm = normalized?.phoneNorm || normPhone(raw);
  return members.find((member) => (
    (memberKey && member.memberKey === memberKey)
    || (clientId && member.clientId === clientId)
    || (phoneNorm && member.phoneNorm === phoneNorm)
  )) || null;
};

export function reconcileResultRosterSnapshot({
  game,
  seedSnapshot = null,
  capturedAt = new Date().toISOString(),
  source = "repair_result_roster_snapshots",
}) {
  const members = [];
  const conflicts = [];
  const push = (value, bucket, index) => {
    const incoming = normalizeMember(value, `Игрок ${index + 1}`, bucket);
    if (!incoming) return;
    const sameId = incoming.clientId
      ? members.find((member) => member.clientId === incoming.clientId)
      : null;
    const samePhone = incoming.phoneNorm
      ? members.find((member) => member.phoneNorm === incoming.phoneNorm)
      : null;
    if (sameId && samePhone && sameId !== samePhone) {
      conflicts.push({
        code: "IDENTITY_SPLIT",
        clientId: incoming.clientId,
        phoneNorm: incoming.phoneNorm,
        memberKeys: [sameId.memberKey, samePhone.memberKey],
      });
      return;
    }
    const existing = sameId
      || samePhone
      || members.find((member) => member.memberKey === incoming.memberKey)
      || null;
    if (existing) {
      if ((existing.clientId && incoming.clientId && existing.clientId !== incoming.clientId)
        || (existing.phoneNorm && incoming.phoneNorm && existing.phoneNorm !== incoming.phoneNorm)) {
        conflicts.push({
          code: "IDENTITY_CONFLICT",
          memberKeys: [existing.memberKey, incoming.memberKey],
          clientIds: uniq([existing.clientId, incoming.clientId]),
          phoneNorms: uniq([existing.phoneNorm, incoming.phoneNorm]),
        });
        return;
      }
      Object.assign(existing, mergeMember(existing, incoming));
      return;
    }
    members.push(incoming);
  };

  snapshotMembers(seedSnapshot).forEach((member, index) => {
    const normalized = normalizeMember(member, `Игрок ${index + 1}`, member?.bucket || "participant");
    if (normalized && !normalized.clientId && !normalized.phoneNorm) {
      conflicts.push({
        code: "UNRESOLVED_LEGACY_MEMBER",
        memberKey: normalized.memberKey,
        name: normalized.name,
      });
      return;
    }
    push(member, member?.bucket || "participant", index);
  });
  asArray(game?.participants).forEach((member, index) => push(member, "participant", index));
  asArray(game?.waitlist).forEach((member, index) => push(member, "waitlist", index));
  if (game?.organizer || game?.createdBy) push(game.organizer || game.createdBy, "participant", members.length);

  const storedInitial = asArray(seedSnapshot?.initialTeamMemberKeys).length > 0
    ? seedSnapshot.initialTeamMemberKeys
    : asArray(seedSnapshot?.initialTeamSlots);
  const gameInitial = asArray(game?.metadata?.teamSlots).length > 0
    ? game.metadata.teamSlots
    : asArray(game?.teamSlots);
  const initialSource = storedInitial.length > 0 ? storedInitial : gameInitial;
  const initialTeamMembers = Array.from({ length: 4 }, (_, index) => (
    resolveMember(members, initialSource[index])
    || members.filter((member) => member.bucket !== "waitlist")[index]
    || null
  ));
  const initialTeamMemberKeys = initialTeamMembers.map((member) => member?.memberKey).filter(Boolean);
  const participantMemberKeys = members
    .filter((member) => member.bucket !== "waitlist")
    .map((member) => member.memberKey);
  const waitlistMemberKeys = members
    .filter((member) => member.bucket === "waitlist")
    .map((member) => member.memberKey);
  const sanitizedMembers = members.map((member) => ({ ...member }));

  return {
    snapshot: {
      version: "result-roster-snapshot-v3",
      schemaVersion: 3,
      source,
      capturedAt,
      capturedAtTs: Date.parse(capturedAt),
      members: sanitizedMembers,
      playerPool: sanitizedMembers,
      allPlayers: sanitizedMembers,
      allowedMemberKeys: members.map((member) => member.memberKey),
      allowedClientIds: uniq(members.map((member) => member.clientId)),
      allowedPhoneNorms: uniq(members.map((member) => member.phoneNorm)),
      participantMemberKeys,
      waitlistMemberKeys,
      initialTeamMemberKeys,
      initialTeamSlots: initialTeamMembers.map((member) => (
        member
          ? {
            memberKey: member.memberKey,
            clientId: member.clientId,
            id: member.id,
            phoneNorm: member.phoneNorm,
            name: member.name,
          }
          : null
      )),
    },
    conflicts,
    stats: {
      memberCount: members.length,
      participantCount: participantMemberKeys.length,
      waitlistCount: waitlistMemberKeys.length,
      initialTeamCount: initialTeamMemberKeys.length,
    },
  };
}

export function inspectResultRosterDrift(game, snapshot) {
  const actualIds = uniq(asArray(game?.participants)
    .map((member) => toStr(member?.clientId || member?.id || member?.uuid || member?.userId || member?.playerId)));
  const actualPhones = uniq(asArray(game?.participants)
    .map((member) => normPhone(member?.phoneNorm || member?.phone || member?.phoneNumber || member?.mobile)));
  const stored = snapshotMembers(snapshot).map((member, index) => normalizeMember(member, `Игрок ${index + 1}`, member?.bucket));
  const storedIds = uniq(stored.map((member) => member?.clientId));
  const storedPhones = uniq(stored.map((member) => member?.phoneNorm));
  const duplicateIds = storedIds.filter((id) => stored.filter((member) => member?.clientId === id).length > 1);
  const duplicatePhones = storedPhones.filter((phone) => stored.filter((member) => member?.phoneNorm === phone).length > 1);
  const rawSchemaVersion = snapshot?.schemaVersion ?? snapshot?.version ?? 0;
  const numericSchemaVersion = Number(rawSchemaVersion);
  const parsedSchemaVersion = Number.isFinite(numericSchemaVersion)
    ? numericSchemaVersion
    : Number(String(rawSchemaVersion).match(/v(\d+)$/i)?.[1] || 0);
  return {
    missingClientIds: actualIds.filter((id) => !storedIds.includes(id)),
    missingPhones: actualPhones.filter((phone) => !storedPhones.includes(phone)),
    duplicateIds,
    duplicatePhones,
    needsRepair: parsedSchemaVersion < 3
      || actualIds.some((id) => !storedIds.includes(id))
      || actualPhones.some((phone) => !storedPhones.includes(phone))
      || duplicateIds.length > 0
      || duplicatePhones.length > 0,
  };
}
