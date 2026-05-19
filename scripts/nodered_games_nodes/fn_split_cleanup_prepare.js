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

const parseTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
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

const rows = asArray(msg.payload);
const request = isObj(msg._splitCleanupRequest) ? msg._splitCleanupRequest : {};
const nowTs = Number.isFinite(Number(request.nowTs)) ? Number(request.nowTs) : Date.now();
const nowIso = toStr(request.nowIso) || new Date(nowTs).toISOString();
const dryRun = request.dryRun === true;
const force = request.force === true;
const limit = Math.max(1, Math.min(500, Math.floor(toNumber(request.limit) || 200)));

const tasks = [];

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
  if (!splitEnabled) return;

  const shareCount = resolveShareCount(game, splitPayment);
  const participantsCount = asArray(game.participants).length;
  const payments = asArray(splitPayment?.payments).filter((item) => isObj(item));
  const paidPaymentsCount = payments.filter((item) => isPaidStatus(item.status)).length;
  const allPartsPaid = paidPaymentsCount >= shareCount;

  const paymentPending = isPendingStatus(status) || game?.payment?.paid === false;

  const deadlineAt = toStr(splitPayment?.deadlineAt);
  const deadlineTs = parseTs(deadlineAt);
  const deadlineExpired = deadlineTs !== null && nowTs >= deadlineTs;

  const assembleDeadlineAtRaw = toStr(splitPayment?.assembleDeadlineAt);
  const assembleDeadlineTsRaw = parseTs(assembleDeadlineAtRaw);
  const startTs = resolveStartTs(game);
  const assembleDeadlineTs = assembleDeadlineTsRaw !== null
    ? assembleDeadlineTsRaw
    : (startTs !== null ? (startTs - 24 * 60 * 60 * 1000) : null);
  const assembleDeadlineAt = assembleDeadlineTs !== null ? new Date(assembleDeadlineTs).toISOString() : null;
  const assembleDeadlineExpired = assembleDeadlineTs !== null && nowTs >= assembleDeadlineTs;

  let reason = null;
  if (paymentPending && deadlineExpired) {
    reason = "PAYMENT_TIMEOUT";
  } else if (assembleDeadlineExpired && (!allPartsPaid || participantsCount < shareCount)) {
    reason = "ASSEMBLY_TIMEOUT";
  }

  if (!reason && force) {
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

  const exerciseId =
    toStr(splitPayment?.vivaExerciseId)
    || toStr(game?.booking?.vivaExerciseId)
    || toStr(game?.booking?.exerciseId)
    || toStr(metadata.vivaExerciseId)
    || toStr(metadata.exerciseId);

  tasks.push({
    gameId,
    reason,
    shareCount,
    participantsCount,
    paidPaymentsCount,
    allPartsPaid,
    statusBefore: status || null,
    paymentPaid: game?.payment?.paid === true,
    deadlineAt,
    assembleDeadlineAt,
    bookingIds,
    exerciseId,
    dryRun,
    preparedAt: nowIso,
  });
});

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
  return [null, msg, msg];
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

return [msg, null, msg];
