// Shared response/export projection. Identity generation is supplied by the caller:
// server responses use a scoped HMAC; local file exports use random, file-local IDs.
// This factory is self-contained so the guarded Node-RED builder can embed it.
export function createPublicPhoneData(aliasForPhone) {
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  const phoneKey = (key) => /(?:^|[^a-z0-9])(?:phones?|mobiles?|telephones?|msisdn)(?:[^a-z0-9]|$)/i
    .test(String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
  const phoneIdentity = (value) => {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).trim().replace(/^(?:phone|mobile|telephone|msisdn|id):/i, "");
    if (!/^(?:\+?[\d\s().-]+)$/.test(text)) return null;
    const digits = text.replace(/\D/g, "");
    if (digits.length === 10) return "7" + digits;
    if (digits.length === 11 && /^[78]/.test(digits)) return "7" + digits.slice(1);
    if (text.startsWith("+") && digits.length >= 8 && digits.length <= 15) return digits;
    return null;
  };
  const idKey = (key) => /(?:^id$|(?:Id|Ids|Key|Keys)$|^(?:id|ids|key|keys|pair1|pair2|byes|pairAssignments|readyParticipantIds|participantReadyIds|teamSlots|initialTeamSlots|slots)$)/.test(key);
  const referenceValue = (value) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  const textWithoutPhone = (value) => value
    .replace(/([?&][^=&#]*(?:phone|mobile|telephone|msisdn)[^=&#]*=)[^&#]*/gi, "$1[redacted]")
    .replace(/\btel:[+\d(). -]+/gi, "[redacted]")
    // Reprocessing an issued HMAC must preserve it even when its random hex
    // happens to contain a phone-shaped digit sequence.
    .split(/((?<![0-9a-f])(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{24})(?![0-9a-f])|(?<![a-z0-9_])pp_[0-9a-f]{32}(?![0-9a-f]))/gi)
    .map((part, index) => index % 2 === 1 ? part : part.replace(/(^|[^\d])((?:\+?7|8)(?:[\s().-]*\d){10})(?!\d)/g, "$1[redacted]"))
    .join("");
  const alias = (value, scope) => {
    const token = identityToken(value);
    return token ? aliasForPhone(token, scope) : value;
  };
  // Composite legacy keys can contain a phone too. Hash the complete identity
  // rather than replacing a substring and collapsing different event keys.
  const identityToken = (value) => phoneIdentity(value)
    || (typeof value === "string" && /^rm_[a-z0-9]+$/i.test(value) ? "legacy-result-member:" + value : null)
    || (typeof value === "string" && textWithoutPhone(value) !== value ? "legacy-id:" + value : null);
  const identityFields = ["id", "clientId", "userId", "playerId", "authorId", "senderId", "memberKey"];
  const contactFields = ["phone", "phoneNorm", "phoneNumber", "mobile", "playerPhone", "authorPhone"];
  const ownIdentity = (value, viewer) => {
    if (!record(value) || !viewer) return false;
    const ids = identityFields.map((key) => value[key]).filter((id) => id != null && !phoneIdentity(id));
    if (viewer.id && ids.length) return ids.some((id) => String(id) === String(viewer.id));
    const phone = phoneIdentity(viewer.phone);
    return Boolean(phone && [...contactFields.map((key) => value[key]), ...identityFields.map((key) => value[key])]
      .some((candidate) => phoneIdentity(candidate) === phone));
  };
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
  const memberFields = ["id", "clientId", "userId", "uuid", "playerId", "playerKey", "participantKey", "memberKey", "rosterMemberKey", "membershipId", "membership_id", "name", "displayName", "firstName", "lastName", "fullName", "surname", "photo", "avatar", "avatarUrl", "imageUrl", "role", "status", "state", "origin", "type", "level", "levelScore", "levelLabel", "levelNumeric", "grade", "rating", "ratingNumeric", "numericRating", "joinedAt", "joinedTs", "createdAt", "isViewer", "bucket", "source", "tenantKey", "matchesPlayed", "gamesPlayed", "played", "wins", "losses", "draws", "spot", "isCancelled"];
  const messageFields = ["id", "_id", "messageId", "gameId", "communityId", "postId", "text", "body", "type", "createdAt", "createdTs", "editedAt", "deleted", "sender", "author", "authorId", "authorName", "authorAvatar", "authorIsViewer", "attachments"];
  const ratingFields = ["rank", "place", "communityId", "playerId", "playerKey", "playerName", "avatarUrl", "currentLevel", "levelDelta", "lastRatingDelta", "lastRatingChangedAt", "gamesPlayed", "gamesWon", "gamesLost", "gamesDrawn", "winRate", "setsWon", "setsLost", "gamesWonCount", "gamesLostCount", "gamesDiff", "gamesRawScore", "gamesReliabilityFactor", "gamesNormalized", "tournamentsPlayed", "tournamentsWon", "tournamentMatchesWon", "tournamentPointsScored", "tournamentPointsDiff", "bestPlace", "averagePlace", "tournamentRawScore", "tournamentReliabilityFactor", "tournamentNormalized", "tournamentScore", "gamesScore", "visitsAttended", "activityScore", "overallScore", "totalEventsPlayed", "lastActivityAt", "score", "totalScore", "scoreParts", "badges", "period", "calculationVersion", "updatedAt", "updatedAtTs", "isViewer"];
  const tournamentFields = ["tournamentId", "exerciseId", "id", "tenantKey", "tournamentType", "targetScore", "courts", "organizer", "participants", "rounds", "params", "playerLogs", "totals", "standings", "summary", "createdAt", "updatedAt", "startRatingChanges", "publishedCommunities", "ratingCommunityId", "ratingCommunityStatus", "title", "name", "displayName", "tournamentName", "label", "participantsCount", "joinedCount", "clientsCount", "maxParticipants", "maxClientsCount", "maxPlayers", "playersLimit", "limit", "minRating", "maxRating", "genderLabel", "gender", "sex", "category", "division", "girlsOnly", "womenOnly", "femaleOnly", "mixed", "mix", "isMixed"];
  function project(value, options = {}) {
    const { scope = "legacy", viewer = null, kind = "generic" } = options;
    function walk(input, currentScope, key = "", parent = "", path = [], gameDepth = null) {
      if (Array.isArray(input)) return input.map((item) => walk(item, currentScope, key, parent, path, gameDepth));
      if (record(input)) {
        // Preserve Date/BSON ObjectId instances and their normal JSON wire format.
        if (Object.prototype.toString.call(input) !== "[object Object]") return input;
        if (input._bsontype === "ObjectId" && typeof input.toHexString === "function"
          && /^[0-9a-f]{24}$/i.test(input.toHexString())) return input;
        const game = kind === "game" && gameDepth === null && input.id
          && (path.length === 0 || (path.length === 1 && ["games", "game", "items"].includes(path[0])));
        if (game) gameDepth = path.length;
        if (input.tournamentId && Array.isArray(input.participants)) {
          currentScope = `tournament:${input.tenantKey || "legacy"}:${input.tournamentId}`;
        } else if (key === "communities" || (Array.isArray(input.members) && input.id)) {
          currentScope = `community:legacy:${input.id || input.communityId}`;
        } else if (input.gameId && key === "chats") {
          currentScope = `game:legacy:${input.gameId}`;
        } else if (game) {
          currentScope = `game:legacy:${input.id}`;
        }
        const member = ["members", "pendingMembers", "memberPreview", "participants", "waitlist", "sender", "author", "organizer", "member"].includes(key);
        const message = ["messages", "message", "lastMessage", "comments"].includes(key) || (kind === "chat" && key === "" && input.sender);
        const rating = kind === "rating" && ["rows", "items"].includes(key);
        let source = input;
        if (member && kind !== "game") source = pick(input, memberFields);
        else if (message) source = pick(input, messageFields);
        else if (rating) source = pick(input, ratingFields);
        else if (kind === "tournament" && input.tournamentId && Array.isArray(input.participants)) source = pick(input, tournamentFields);
        if (key === "vivaSync") source = pick(input, ["status", "attempts", "lastAttemptAt", "lastSuccessAt", "totalPlayers", "syncedPlayers"]);
        const gamePath = gameDepth === null ? [] : path.slice(gameDepth);
        let providerFields = [];
        if (gameDepth !== null) {
          if (gamePath.length === 1 && gamePath[0] === "booking") providerFields = ["bookingId", "bookingIds", "exerciseId", "vivaExerciseId"];
          else if (gamePath.length === 1 && gamePath[0] === "payment") providerFields = ["bookingId", "bookingIds", "transactionId", "productId", "exerciseId"];
          else if ((gamePath.length === 1 && gamePath[0] === "metadata")
            || (gamePath.length === 2 && gamePath[0] === "metadata" && gamePath[1] === "splitPayment")) providerFields = ["bookingIds", "exerciseId", "vivaExerciseId"];
          else if (gamePath.length === 3 && gamePath[0] === "metadata" && gamePath[1] === "splitPayment" && gamePath[2] === "payments") providerFields = ["bookingId", "bookingIds", "transactionId", "productId", "exerciseId"];
        }
        const output = {};
        for (const [field, child] of Object.entries(source)) {
          const identityField = identityToken(field);
          if (phoneKey(field) && !identityField) continue;
          const safeField = identityField ? alias(field, currentScope) : field;
          // These exact game records contain provider references. A numeric
          // transaction/booking ID is not a participant's phone identity.
          const providerReference = providerFields.includes(field)
            && (referenceValue(child) || (field === "bookingIds" && Array.isArray(child) && child.every(referenceValue)));
          // Do not permit dictionary keys to mutate object prototypes.
          Object.defineProperty(output, safeField, { value: providerReference ? child : walk(child, currentScope, field, key, [...path, field], gameDepth), enumerable: true, configurable: true, writable: true });
        }
        if (member && !output.id) {
          const stableId = ["clientId", "userId", "uuid", "playerId"].map((field) => output[field]).find(Boolean);
          const phone = contactFields.map((field) => phoneIdentity(input[field])).find(Boolean);
          if (stableId) output.id = stableId;
          else if (phone) output.id = aliasForPhone(phone, currentScope);
        }
        if (member || rating) output.isViewer = ownIdentity(input, viewer);
        if (message || Object.hasOwn(input, "authorPhone")) {
          output.authorIsViewer = ownIdentity({ id: input.authorId || input.senderId, phone: input.authorPhone }, viewer)
            || ownIdentity(input.author || input.sender, viewer);
          if (!output.authorId && input.authorPhone) output.authorId = alias(input.authorPhone, currentScope);
        }
        return output;
      }
      if (typeof input === "string") {
        if (/^rm_[a-z0-9]+$/i.test(input)) return alias(input, currentScope);
        if ((idKey(key) || idKey(parent)) && identityToken(input)) return alias(input, currentScope);
        if (phoneIdentity(input)) return idKey(key) || idKey(parent) ? alias(input, currentScope) : null;
        return textWithoutPhone(input);
      }
      if (typeof input === "number" && phoneIdentity(input) && (idKey(key) || idKey(parent))) return alias(input, currentScope);
      return input;
    }
    return walk(value, scope);
  }

  // Resolves public references only against the supplied, server-read document.
  // Public IDs carry no authority and unknown/cross-scope references fail closed.
  function restore(command, stored, scope) {
    const aliases = new Map();
    const membersByAlias = new Map();
    const storedLocalIds = new Set();
    const register = (value) => {
      if (typeof value === "string" && value.startsWith("manual-participant-public-")) storedLocalIds.add(value);
      if (identityToken(value) && !aliases.has(alias(value, scope))) aliases.set(alias(value, scope), value);
    };
    const collect = (value, key = "") => {
      if (Array.isArray(value)) return value.forEach((item) => collect(item, key));
      if (typeof value === "string" && /^rm_[a-z0-9]+$/i.test(value)) register(value);
      if (!record(value)) return;
      const originalId = value.id || value.playerId || value.memberKey || value.phone || value.phoneNorm;
      if (originalId != null && identityToken(originalId)) {
        const publicId = alias(originalId, scope);
        register(originalId);
        // A later statistics row must not replace the private participant row.
        if (!membersByAlias.has(publicId) || contactFields.some((field) => value[field] != null)) membersByAlias.set(publicId, value);
      }
      for (const [field, child] of Object.entries(value)) {
        register(field);
        if (idKey(field)) {
          if (Array.isArray(child)) child.filter((item) => !record(item)).forEach(register);
          else if (!record(child)) register(child);
        }
        collect(child, field);
      }
    };
    collect(stored);
    function visit(value, key = "", parent = "") {
      if (Array.isArray(value)) return value.map((item) => visit(item, key, parent));
      if (record(value)) {
        const restored = Object.fromEntries(Object.entries(value).map(([field, child]) => {
          const mappedKey = /^pp_[a-f0-9]{32}$/.test(field) ? resolve(field) : field;
          return [mappedKey, visit(child, field, key)];
        }));
        const originalMember = membersByAlias.get(value.id) || membersByAlias.get(value.clientId);
        if (originalMember) {
          // Community commands need the original phone-only target identity inside
          // the server; tournament resaves must not erase a hidden contact field.
          for (const field of ["phone", "phoneNorm", "phoneNumber", "mobile"]) {
            if (originalMember[field] != null) restored[field] = originalMember[field];
          }
          if (Object.hasOwn(value, "id") && (Object.hasOwn(originalMember, "id") || contactFields.some((field) => originalMember[field] != null))) restored.id = originalMember.id || null;
          if (Object.hasOwn(value, "clientId")) restored.clientId = originalMember.id || originalMember.clientId || null;
        }
        return restored;
      }
      if (typeof value === "string" && /^pp_[a-f0-9]{32}$/.test(value) && (idKey(key) || idKey(parent))) return resolve(value);
      // A phone-only local export has no server secret and cannot recover the
      // hidden identity. Do not overwrite an existing tournament with new IDs.
      if (stored && typeof value === "string" && value.startsWith("manual-participant-public-")
        && (idKey(key) || idKey(parent)) && !storedLocalIds.has(value)) throw new Error("PUBLIC_IDENTITY_UNKNOWN");
      return value;
    }
    function resolve(value) {
      if (!aliases.has(value)) throw new Error("PUBLIC_IDENTITY_UNKNOWN");
      return aliases.get(value);
    }
    return visit(command);
  }
  return { project, restore, phoneIdentity, ownIdentity };
}
