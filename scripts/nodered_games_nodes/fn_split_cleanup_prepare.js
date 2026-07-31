const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const clone = (value) => {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
};

const uniq = (values) => {
  const result = [];
  const used = new Set();
  values.forEach((item) => {
    const normalized = toStr(item);
    if (!normalized || used.has(normalized)) return;
    used.add(normalized);
    result.push(normalized);
  });
  return result;
};

const uniqBookingTargets = (values) => {
  const result = [];
  const used = new Set();
  asArray(values).forEach((item) => {
    if (!item || typeof item !== "object") return;
    const bookingId = toStr(item.bookingId || item.id || item.uuid);
    if (!bookingId) return;
    const clientId = toStr(item.clientId || item.playerId || item.userId) || null;
    const key = `${bookingId}|${clientId || ""}`;
    if (used.has(key)) return;
    used.add(key);
    result.push({
      bookingId,
      clientId,
    });
  });
  return result;
};

const parseTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const normalizeComparableId = (value) => {
  const text = toStr(value);
  return text ? text.toLowerCase() : null;
};

const actorMatchesOrganizer = (game, request) => {
  const actorClientId = normalizeComparableId(request.actorClientId);
  const actorPhoneNorm = normalizePhone(request.actorPhoneNorm);
  const organizerIds = [
    game?.organizer?.id,
    game?.organizer?.clientId,
    game?.metadata?.organizerId,
  ]
    .map(normalizeComparableId)
    .filter(Boolean);
  const organizerPhones = [
    game?.organizer?.phoneNorm,
    game?.organizer?.phone,
    game?.metadata?.organizerPhoneNorm,
    game?.metadata?.organizerPhone,
  ]
    .map(normalizePhone)
    .filter(Boolean);

  return Boolean(
    (actorClientId && organizerIds.includes(actorClientId))
    || (actorPhoneNorm && organizerPhones.includes(actorPhoneNorm)),
  );
};

const normalizeRefundMethod = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw.toUpperCase();
  if (["CURRENCY", "DEPOSIT", "SERVICE", "NONE"].includes(normalized)) return normalized;
  return null;
};

const normalizeCancellationActionId = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (["card", "deposit", "subscription", "none"].includes(normalized)) return normalized;
  return null;
};

const resolveStartTs = (game) => {
  const booking = isObj(game?.booking) ? game.booking : null;
  const fromIso = toStr(booking?.timeFromIso);
  const fromIsoTs = parseTs(fromIso);
  if (fromIsoTs !== null) return fromIsoTs;

  const date = toStr(booking?.date);
  const fromTime = toStr(booking?.timeFrom);
  if (!date || !fromTime) return null;

  const normalizedTime = /^\d{2}:\d{2}$/.test(fromTime) ? `${fromTime}:00` : fromTime;
  const ts = Date.parse(`${date}T${normalizedTime}+03:00`);
  return Number.isFinite(ts) ? ts : null;
};

const resolveExerciseDate = (game) => {
  const booking = isObj(game?.booking) ? game.booking : null;
  const explicitDate = toStr(booking?.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicitDate || "")) return explicitDate;

  const timeFromIso = toStr(booking?.timeFromIso);
  const parsed = timeFromIso ? new Date(timeFromIso) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year && byType.month && byType.day
    ? `${byType.year}-${byType.month}-${byType.day}`
    : null;
};

const isPaidStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return false;
  if (status.includes("CANCEL") || status.includes("REFUND")) return false;
  return (
    status.includes("PAID")
    || status.includes("SUCCESS")
    || status.includes("CONFIRM")
    || status.includes("COMPLETE")
    || status.includes("SUBSCRIPTION")
  );
};

const isPendingStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  return (
    status.includes("PENDING")
    || status.includes("DRAFT")
    || status.includes("UNPAID")
    || status.includes("NOT_PAID")
  );
};

const resolveShareCount = (game, splitPayment) => {
  const fromSplit = Math.floor(toNumber(splitPayment?.shareCount) || 0);
  if (fromSplit === 2 || fromSplit === 4) return fromSplit;

  const fromInvite = Math.floor(toNumber(game?.invite?.maxPlayers) || 0);
  if (fromInvite === 2 || fromInvite === 4) return fromInvite;

  return 4;
};

const resolvePaymentDeadlineTs = (paymentItem, splitPayment, fallbackTimeoutMs) => {
  const createdAtTs = parseTs(paymentItem?.createdAt || paymentItem?.updatedAt);
  const fallbackDeadlineTs = createdAtTs === null ? null : createdAtTs + fallbackTimeoutMs;
  const explicitDeadlineTs = parseTs(
    paymentItem?.deadlineAt
    || paymentItem?.expiresAt
    || splitPayment?.participantDeadlineAt
    || splitPayment?.participantPaymentDeadlineAt,
  );
  if (explicitDeadlineTs !== null) {
    if (fallbackDeadlineTs !== null) {
      return Math.min(explicitDeadlineTs, fallbackDeadlineTs);
    }
    return explicitDeadlineTs;
  }
  return fallbackDeadlineTs;
};

const resolvePaymentIdentity = (paymentItem) => ({
  clientId: toStr(paymentItem?.clientId || paymentItem?.playerId || paymentItem?.userId),
  phone: normalizePhone(
    paymentItem?.phoneNorm
    || paymentItem?.clientPhoneNorm
    || paymentItem?.phone
    || paymentItem?.clientPhone,
  ),
  name: toStr(paymentItem?.playerName || paymentItem?.clientName || paymentItem?.name) || "Игрок",
});

const playerMatchesIdentity = (player, identity) => {
  if (!isObj(player) || !identity) return false;
  const playerId = normalizeComparableId(player.id);
  const identityId = normalizeComparableId(identity.clientId);
  if (playerId && identityId && playerId === identityId) return true;
  const playerPhone = normalizePhone(player.phone || player.phoneNorm || player.clientPhone);
  const identityPhone = normalizePhone(identity.phone);
  if (playerPhone && identityPhone && playerPhone === identityPhone) return true;
  return false;
};

const buildPaymentKey = (paymentItem, index) => [
  normalizeComparableId(paymentItem?.paymentRef) || "",
  normalizeComparableId(paymentItem?.clientId || paymentItem?.playerId || paymentItem?.userId) || "",
  normalizePhone(paymentItem?.phoneNorm || paymentItem?.clientPhoneNorm || paymentItem?.phone || paymentItem?.clientPhone) || "",
  toStr(paymentItem?.bookingId) || "",
  String(index),
].join("|");

const normalizeLeaveEvents = (metadata) => {
  const leaveEvents = asArray(metadata?.leaveEvents);
  if (leaveEvents.length > 0) return leaveEvents;
  const playerLeaveEvents = asArray(metadata?.playerLeaveEvents);
  if (playerLeaveEvents.length > 0) return playerLeaveEvents;
  return asArray(metadata?.leftPlayers);
};

const rows = asArray(msg.payload);
const request = isObj(msg._splitCleanupRequest) ? msg._splitCleanupRequest : {};
const nowTs = Number.isFinite(Number(request.nowTs)) ? Number(request.nowTs) : Date.now();
const nowIso = toStr(request.nowIso) || new Date(nowTs).toISOString();
const dryRun = request.dryRun === true;
const force = request.force === true;
const requestGameId = toStr(request.gameId);
const requestIntent = toStr(request.intent)?.toLowerCase() || null;
const allowForceGameCancel = request.allowForceGameCancel === true || requestIntent === "cancel_game";
const preferredRefundMethod = normalizeRefundMethod(request.preferredRefundMethod);
const cancellationActionId = normalizeCancellationActionId(request.cancellationActionId);
const actorBookingId = toStr(request.actorBookingId);
const limit = Math.max(1, Math.min(500, Math.floor(toNumber(request.limit) || 200)));
const PARTICIPANT_PAYMENT_TIMEOUT_MS = 10 * 60 * 1000;

const tasks = [];
let authorizationFailure = null;

rows.forEach((game) => {
  if (!isObj(game)) return;
  const gameId = toStr(game.id);
  if (!gameId) return;

  const status = String(game.status || "").trim().toUpperCase();
  if (status.includes("CANCEL")) return;

  const metadata = isObj(game.metadata) ? game.metadata : {};
  const splitPayment = isObj(metadata.splitPayment) ? metadata.splitPayment : null;
  const payMode = String(game?.settings?.payMode || "").trim().toLowerCase();
  const splitEnabled = payMode === "split" || splitPayment?.enabled === true;
  const explicitForceTarget = Boolean(
    force
    && allowForceGameCancel
    && requestGameId
    && requestGameId === gameId,
  );
  if (!splitEnabled && !explicitForceTarget) return;
  if (explicitForceTarget && !actorMatchesOrganizer(game, request)) {
    authorizationFailure = {
      code: "SPLIT_CLEANUP_ORGANIZER_REQUIRED",
      error: "Отменить игру может только её организатор",
    };
    return;
  }

  const participants = asArray(game.participants).filter((item) => isObj(item));
  const waitlist = asArray(game.waitlist).filter((item) => isObj(item));
  const payments = asArray(splitPayment?.payments).filter((item) => isObj(item));

  const timedOutPaymentItems = [];
  payments.forEach((paymentItem, index) => {
    const paymentStatus = String(paymentItem.status || "").trim().toUpperCase();
    if (paymentStatus !== "PAYMENT_PENDING") return;
    const paymentAmountMinor = toNumber(paymentItem.amountMinor);
    const paymentAmount = toNumber(paymentItem.amount);
    // Subscription/zero-cost joins can be instantly paid without redirect; do not timeout-remove them.
    if (
      (paymentAmountMinor !== null && paymentAmountMinor <= 0)
      || (paymentAmount !== null && paymentAmount <= 0)
    ) {
      return;
    }
    const deadlineTs = resolvePaymentDeadlineTs(paymentItem, splitPayment, PARTICIPANT_PAYMENT_TIMEOUT_MS);
    if (deadlineTs === null || nowTs < deadlineTs) return;
    const identity = resolvePaymentIdentity(paymentItem);
    const matchedParticipant = participants.find((player) => playerMatchesIdentity(player, identity)) || null;
    const matchedWaitlist = waitlist.find((player) => playerMatchesIdentity(player, identity)) || null;
    const playerSnapshot = matchedParticipant || matchedWaitlist || null;
    const playerBucket = matchedParticipant
      ? "participants"
      : (matchedWaitlist ? "waitlist" : null);
    timedOutPaymentItems.push({
      paymentItem,
      index,
      key: buildPaymentKey(paymentItem, index),
      bookingIds: uniq([
        ...asArray(paymentItem.bookingIds),
        paymentItem.bookingId,
      ]),
      identity,
      deadlineAt: new Date(deadlineTs).toISOString(),
      transactionId: toStr(paymentItem.transactionId || paymentItem.transaction?.id || paymentItem.transactionUuid),
      paymentRef: toStr(paymentItem.paymentRef),
      playerSnapshot: playerSnapshot ? clone(playerSnapshot) : null,
      playerBucket,
    });
  });

  if (timedOutPaymentItems.length > 0 && !explicitForceTarget) {
    const timedOutKeys = new Set(timedOutPaymentItems.map((item) => item.key));
    const timedOutIdentities = timedOutPaymentItems.map((item) => item.identity);
    const timedOutBookingIds = uniq(timedOutPaymentItems.flatMap((item) => item.bookingIds));
    const timedOutBookingTargets = uniqBookingTargets(
      timedOutPaymentItems.flatMap((item) => (
        item.bookingIds.map((bookingId) => ({
          bookingId,
          clientId: item.identity.clientId || null,
        }))
      )),
    );
    const nextParticipants = participants.filter((player) => (
      !timedOutIdentities.some((identity) => playerMatchesIdentity(player, identity))
    ));
    const nextWaitlist = waitlist.filter((player) => (
      !timedOutIdentities.some((identity) => playerMatchesIdentity(player, identity))
    ));
    const nextSplitPayments = payments.map((paymentItem, index) => {
      const key = buildPaymentKey(paymentItem, index);
      if (!timedOutKeys.has(key)) return paymentItem;
      return {
        ...paymentItem,
        status: "EXPIRED",
        cancelReason: "PAYMENT_TIMEOUT",
        cancelledAt: nowIso,
        leftAt: nowIso,
      };
    });
    const baseLeaveEvents = normalizeLeaveEvents(metadata);
    const timeoutLeaveEvents = timedOutPaymentItems.map((item) => ({
      playerId: item.identity.clientId || null,
      playerPhone: item.identity.phone || null,
      playerName: item.identity.name,
      leftAt: nowIso,
      reason: "AUTO_PAYMENT_TIMEOUT",
      byId: "split_cleanup",
      byPhone: null,
      byName: "Split cleanup",
    }));
    const hasVivaTargets = timedOutBookingTargets.length > 0 || timedOutBookingIds.length > 0;

    tasks.push({
      mode: "PARTICIPANT_TIMEOUT",
      gameId,
      reason: "PAYMENT_TIMEOUT",
      statusBefore: status || null,
      paymentPaid: game?.payment?.paid === true,
      bookingIds: timedOutBookingIds,
      bookingTargets: timedOutBookingTargets,
      exerciseId: null,
      dryRun,
      preparedAt: nowIso,
      nextParticipants,
      nextWaitlist,
      nextSplitPayments,
      nextLeaveEvents: [...baseLeaveEvents, ...timeoutLeaveEvents],
      blockLocalMutation: !hasVivaTargets,
      blockReason: hasVivaTargets ? null : "missing_viva_targets",
      timedOutPayments: timedOutPaymentItems.map((item) => ({
        paymentRef: toStr(item.paymentItem.paymentRef),
        transactionId: item.transactionId || null,
        clientId: item.identity.clientId || null,
        phone: item.identity.phone || null,
        name: item.identity.name,
        playerBucket: item.playerBucket || null,
        playerSnapshot: item.playerSnapshot ? clone(item.playerSnapshot) : null,
        bookingIds: item.bookingIds,
        deadlineAt: item.deadlineAt,
      })),
    });
    return;
  }

  const shareCount = resolveShareCount(game, splitPayment);
  const participantsCount = participants.length;
  const waitlistCount = waitlist.length;
  const hasActiveRoster = participantsCount > 0 || waitlistCount > 0;
  const paidPaymentsCount = payments.filter((item) => isPaidStatus(item.status)).length;
  const pendingPaymentsCount = payments.filter((item) => isPendingStatus(item.status)).length;
  const allPartsPaid = paidPaymentsCount >= shareCount;

  const assembleDeadlineAtRaw = toStr(splitPayment?.assembleDeadlineAt);
  const assembleDeadlineTsRaw = parseTs(assembleDeadlineAtRaw);
  const startTs = resolveStartTs(game);
  const assembleDeadlineTs = assembleDeadlineTsRaw !== null
    ? assembleDeadlineTsRaw
    : (startTs !== null ? (startTs - 24 * 60 * 60 * 1000) : null);
  const assembleDeadlineAt = assembleDeadlineTs !== null ? new Date(assembleDeadlineTs).toISOString() : null;
  const assembleDeadlineExpired = assembleDeadlineTs !== null && nowTs >= assembleDeadlineTs;

  let reason = null;
  if (
    assembleDeadlineExpired
    && paidPaymentsCount === 0
    && pendingPaymentsCount === 0
    && !hasActiveRoster
    && (!allPartsPaid || participantsCount < shareCount)
  ) {
    reason = "ASSEMBLY_TIMEOUT";
  }
  if (!reason && explicitForceTarget) {
    reason = "FORCED";
  }
  if (!reason) return;

  const bookingIds = uniq([
    ...asArray(game?.booking?.bookingIds),
    game?.booking?.bookingId,
    ...asArray(splitPayment?.bookingIds),
    splitPayment?.organizerBookingId,
    ...payments.map((item) => item.bookingId),
  ]);
  const bookingTargets = uniqBookingTargets([
    ...payments.map((item) => ({
      bookingId: item.bookingId,
      clientId: item.clientId || item.playerId || item.userId || null,
    })),
    ...asArray(splitPayment?.bookingTargets),
  ]);
  const actorBookingLinked = !actorBookingId || (
    bookingIds.some((bookingId) => (
      normalizeComparableId(bookingId) === normalizeComparableId(actorBookingId)
    ))
    || bookingTargets.some((target) => (
      normalizeComparableId(target.bookingId) === normalizeComparableId(actorBookingId)
    ))
  );
  if (explicitForceTarget && !actorBookingLinked) {
    authorizationFailure = {
      code: "SPLIT_CLEANUP_ACTOR_BOOKING_NOT_LINKED",
      error: "Запись клиента не связана с отменяемой игрой",
    };
    return;
  }

  const exerciseId =
    toStr(splitPayment?.vivaExerciseId)
    || toStr(game?.booking?.vivaExerciseId)
    || toStr(game?.booking?.exerciseId)
    || toStr(metadata.vivaExerciseId)
    || toStr(metadata.exerciseId);
  const exerciseDate = resolveExerciseDate(game);
  const hasVivaTargets = bookingTargets.length > 0 || bookingIds.length > 0 || Boolean(exerciseId);
  const missingExerciseDate = Boolean(exerciseId) && !exerciseDate;

  tasks.push({
    mode: "GAME_CLEANUP",
    gameId,
    reason,
    shareCount,
    participantsCount,
    waitlistCount,
    hasActiveRoster,
    paidPaymentsCount,
    pendingPaymentsCount,
    allPartsPaid,
    statusBefore: status || null,
    paymentPaid: game?.payment?.paid === true,
    deadlineAt: toStr(splitPayment?.deadlineAt),
    assembleDeadlineAt,
    bookingIds,
    bookingTargets,
    exerciseId,
    exerciseDate,
    preferredRefundMethod,
    cancellationActionId,
    actorBookingId,
    blockLocalMutation: !hasVivaTargets || missingExerciseDate,
    blockReason: !hasVivaTargets
      ? "missing_viva_targets"
      : (missingExerciseDate ? "missing_exercise_date" : null),
    dryRun,
    preparedAt: nowIso,
  });
});

if (authorizationFailure) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    ok: false,
    code: authorizationFailure.code,
    error: authorizationFailure.error,
  };
  return [null, msg, null];
}

if (tasks.length === 0) {
  msg.statusCode = 200;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    ok: true,
    dryRun,
    checked: rows.length,
    processed: 0,
    cancelled: 0,
    withVivaErrors: 0,
    now: nowIso,
    items: [],
  };
  return [null, msg, null];
}

const selectedTasks = tasks.slice(0, limit);
msg._splitCleanupRequest = {
  ...request,
  nowTs,
  nowIso,
  dryRun,
  force,
  limit,
  checkedCount: rows.length,
  selectedCount: selectedTasks.length,
};
msg.payload = selectedTasks;

return [msg, null, null];
