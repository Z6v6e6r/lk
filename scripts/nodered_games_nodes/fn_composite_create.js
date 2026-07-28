const MAX_SEGMENTS = 2;
const MAX_TRANSITIONS = 1;
const AUDIT_MAX_EVENTS = 100;
const ALLOWED_PATTERNS = [
  {
    key: "single-60",
    label: "60 минут одной записью",
    targetDurationMinutes: 60,
    durations: [60],
  },
  {
    key: "double-30-30",
    label: "60 минут как 30 + 30",
    targetDurationMinutes: 60,
    durations: [30, 30],
  },
  {
    key: "double-60-30",
    label: "90 минут как 60 + 30",
    targetDurationMinutes: 90,
    durations: [60, 30],
  },
  {
    key: "double-30-60",
    label: "90 минут как 30 + 60",
    targetDurationMinutes: 90,
    durations: [30, 60],
  },
  {
    key: "double-60-60",
    label: "120 минут как 60 + 60",
    targetDurationMinutes: 120,
    durations: [60, 60],
  },
];
const ALLOWED_PATTERN_BY_SIGNATURE = new Map(
  ALLOWED_PATTERNS.map((pattern) => [pattern.durations.join("+"), pattern]),
);

const asObj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const uniq = (items) => Array.from(new Set(items.filter(Boolean)));

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const toFiniteNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const toStringArray = (value) => uniq(asArray(value).map((item) => toStr(item)));

const normalizeTime = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

const normalizeDate = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
};

const resolvePattern = (segments) => {
  const signature = segments.map((segment) => segment.durationMinutes).join("+");
  return ALLOWED_PATTERN_BY_SIGNATURE.get(signature) || null;
};

const buildRoomsLabel = (segments) => {
  if (segments.length === 0) return "Корт не определён";
  if (segments.length === 1) return segments[0].roomName || "Корт";
  const [first, second] = segments;
  if (first.roomId === second.roomId) {
    return first.roomName || second.roomName || "Корт";
  }
  return `${first.roomName || "Корт"} -> ${second.roomName || "Корт"}`;
};

const sumPrice = (segments) => {
  if (segments.some((segment) => segment.price === null || segment.price === undefined)) return null;
  return segments.reduce((sum, segment) => sum + (segment.price || 0), 0);
};

const normalizeSegment = (rawValue, index, defaults = {}) => {
  const raw = asObj(rawValue);
  const stationId = toStr(raw.stationId || raw.stationUUID || raw.stationUuid || defaults.stationId);
  const studioId = toStr(raw.studioId || raw.clubId || raw.clubUUID || raw.studioUuid || defaults.studioId || defaults.stationId);
  const roomId = toStr(raw.roomId || raw.courtId || raw.roomUUID || raw.roomUuid);
  const date = normalizeDate(raw.date || raw.day || raw.bookingDate || defaults.date);
  const timeFrom = normalizeTime(raw.timeFrom || raw.fromTime || raw.startTime || raw.time);
  const timeTo = normalizeTime(raw.timeTo || raw.toTime || raw.endTime);
  const slotId = toStr(raw.slotId || raw.id || raw.uuid);
  const startAt = date && timeFrom ? `${date}T${timeFrom}:00+03:00` : null;
  const endAt = date && timeTo ? `${date}T${timeTo}:00+03:00` : null;
  const startTs = startAt ? Date.parse(startAt) : Number.NaN;
  const endTs = endAt ? Date.parse(endAt) : Number.NaN;

  const missingFields = [];
  if (!stationId) missingFields.push("stationId");
  if (!studioId) missingFields.push("studioId");
  if (!roomId) missingFields.push("roomId");
  if (!date) missingFields.push("date");
  if (!timeFrom) missingFields.push("timeFrom");
  if (!timeTo) missingFields.push("timeTo");

  if (missingFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_segment",
        index,
        message: "Segment is missing required fields",
        details: { missingFields },
      },
    };
  }

  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
    return {
      ok: false,
      error: {
        code: "invalid_segment_time_range",
        index,
        message: "Segment has invalid time range",
        details: { timeFrom, timeTo },
      },
    };
  }

  return {
    ok: true,
    value: {
      slotId: slotId || `slot_${index + 1}`,
      stationId,
      studioId,
      roomId,
      roomName: toStr(raw.roomName || raw.courtName || raw.title),
      date,
      timeFrom,
      timeTo,
      startAt,
      endAt,
      startTs,
      endTs,
      durationMinutes: Math.round((endTs - startTs) / 60000),
      price: toFiniteNumber(raw.price ?? raw.amount),
      subServiceIds: toStringArray(raw.subServiceIds),
    },
  };
};

const buildCompositeCandidate = (rawSegments, defaults = {}) => {
  const normalizedResults = asArray(rawSegments).map((segment, index) => normalizeSegment(segment, index, defaults));
  const errors = normalizedResults.filter((item) => item.ok === false).map((item) => item.error);
  if (errors.length > 0) {
    return { ok: false, error: { code: "invalid_segments", message: "Composite segments are invalid", details: errors } };
  }

  const segments = normalizedResults
    .map((item) => item.value)
    .sort((left, right) => left.startTs - right.startTs);

  if (segments.length === 0) {
    return { ok: false, error: { code: "empty_segments", message: "At least one segment is required" } };
  }
  if (segments.length > MAX_SEGMENTS) {
    return {
      ok: false,
      error: {
        code: "too_many_segments",
        message: `Composite supports at most ${MAX_SEGMENTS} segments`,
        details: { maxSegments: MAX_SEGMENTS, actualSegments: segments.length },
      },
    };
  }

  const first = segments[0];
  const mismatches = [];
  let transitionCount = 0;
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (current.stationId !== first.stationId) mismatches.push({ code: "mixed_station", index, stationId: current.stationId });
    if (current.studioId !== first.studioId) mismatches.push({ code: "mixed_studio", index, studioId: current.studioId });
    if (current.date !== first.date) mismatches.push({ code: "mixed_date", index, date: current.date });
    if (current.startTs < previous.endTs) {
      return {
        ok: false,
        error: {
          code: "overlap_detected",
          message: "Composite segments must not overlap",
          details: { previousIndex: index - 1, currentIndex: index },
        },
      };
    }
    if (current.startTs > previous.endTs) {
      return {
        ok: false,
        error: {
          code: "gap_detected",
          message: "Composite segments must be contiguous without gaps",
          details: { previousIndex: index - 1, currentIndex: index },
        },
      };
    }
    if (current.roomId !== previous.roomId) transitionCount += 1;
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      error: {
        code: "mixed_location",
        message: "Composite segments must belong to the same station, studio and date",
        details: mismatches,
      },
    };
  }

  if (transitionCount > MAX_TRANSITIONS) {
    return {
      ok: false,
      error: {
        code: "too_many_transitions",
        message: `Composite supports at most ${MAX_TRANSITIONS} room transition`,
        details: { maxTransitions: MAX_TRANSITIONS, actualTransitions: transitionCount },
      },
    };
  }

  const pattern = resolvePattern(segments);
  if (!pattern) {
    return {
      ok: false,
      error: {
        code: "unsupported_pattern",
        message: "Composite supports only 60, 30+30, 60+30, 30+60 or 60+60 patterns",
        details: {
          durations: segments.map((segment) => segment.durationMinutes),
          allowedPatterns: ALLOWED_PATTERNS.map((item) => ({
            key: item.key,
            durations: item.durations,
            targetDurationMinutes: item.targetDurationMinutes,
          })),
        },
      },
    };
  }

  const dedupeKey = [
    first.stationId,
    first.studioId,
    first.date,
    ...segments.map((segment) => `${segment.roomId}:${segment.timeFrom}-${segment.timeTo}`),
  ].join("|");
  const roomsLabel = buildRoomsLabel(segments);
  const totalPrice = sumPrice(segments);

  return {
    ok: true,
    value: {
      compositeBooking: {
        version: 1,
        dedupeKey: `composite:${dedupeKey}`,
        stationId: first.stationId,
        studioId: first.studioId,
        date: first.date,
        timeFrom: first.timeFrom,
        timeTo: segments[segments.length - 1].timeTo,
        startAt: first.startAt,
        endAt: segments[segments.length - 1].endAt,
        segmentCount: segments.length,
        transitionCount,
        roomIds: uniq(segments.map((segment) => segment.roomId)),
        totalDurationMinutes: segments.reduce((sum, segment) => sum + segment.durationMinutes, 0),
        targetDurationMinutes: pattern.targetDurationMinutes,
        patternKey: pattern.key,
        patternLabel: pattern.label,
        roomsLabel,
        totalPrice,
      },
      segments: segments.map((segment, index) => ({
        index,
        slotId: segment.slotId,
        stationId: segment.stationId,
        studioId: segment.studioId,
        roomId: segment.roomId,
        roomName: segment.roomName,
        date: segment.date,
        timeFrom: segment.timeFrom,
        timeTo: segment.timeTo,
        startAt: segment.startAt,
        endAt: segment.endAt,
        durationMinutes: segment.durationMinutes,
        price: segment.price,
        subServiceIds: segment.subServiceIds,
      })),
    },
  };
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const buildAuditEvent = (nowIso, type, payload) => ({
  id: `composite_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  at: nowIso,
  type,
  source: "composite_games",
  payload,
});

const body = asObj(msg.payload);
const requestDefaults = {
  stationId: toStr(body.stationId || body.stationUUID || body.stationUuid),
  studioId: toStr(body.studioId || body.clubId || body.clubUUID || body.studioUuid),
  date: normalizeDate(body.date || body.day || body.bookingDate),
};
const rawSegments = asArray(body.segments).length > 0
  ? body.segments
  : asArray(body.compositeBooking && body.compositeBooking.segments);

if (rawSegments.length === 0) {
  return fail(400, "segments array is required");
}

const built = buildCompositeCandidate(rawSegments, requestDefaults);
if (!built.ok) {
  return fail(400, built.error.message, built.error.details || built.error);
}

const nowIso = new Date().toISOString();
const compositeId = toStr(body.id || body.compositeId) || `composite_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const paymentRef = toStr(body.paymentRef || body.paymentRefId || body.paymentReference || asObj(body.payment).paymentRef);
const organizerInput = asObj(body.organizer);
const organizer = {
  clientId: toStr(organizerInput.clientId || organizerInput.id || body.clientId),
  phone: normalizePhone(organizerInput.phone || organizerInput.phoneNorm || body.clientPhone || body.phone),
  name: toStr(organizerInput.name || organizerInput.fullName || body.clientName) || "Организатор",
};
const metadataInput = asObj(body.metadata);
const settingsInput = asObj(body.settings);

const compositeBooking = Object.assign({}, built.value.compositeBooking, {
  status: "DRAFT",
  paymentStatus: "NOT_READY_FOR_PAYMENT",
  readyForPayment: false,
  notReadyReason: "composite_payment_flow_not_implemented",
});

const record = {
  id: compositeId,
  type: "COMPOSITE_BOOKING",
  source: toStr(body.source) || "padlhub_lk",
  status: "DRAFT",
  paymentStatus: "NOT_READY_FOR_PAYMENT",
  organizer,
  compositeBooking,
  segments: built.value.segments,
  payment: {
    paymentRef: paymentRef || null,
    status: "NOT_READY_FOR_PAYMENT",
    ready: false,
  },
  settings: {
    payMode: toStr(settingsInput.payMode || body.payMode) || "composite",
    isPrivate: typeof settingsInput.isPrivate === "boolean" ? settingsInput.isPrivate : null,
  },
  metadata: Object.assign({}, metadataInput, {
    compositeContractVersion: 1,
  }),
  updatedAt: nowIso,
};

const auditEvent = buildAuditEvent(nowIso, "COMPOSITE_CREATED", {
  compositeId,
  requestPath: toStr(msg.req && (msg.req.path || msg.req.originalUrl || msg.req.url)),
  dedupeKey: compositeBooking.dedupeKey,
  paymentRef: paymentRef || null,
  segmentCount: compositeBooking.segmentCount,
  transitionCount: compositeBooking.transitionCount,
});

const dbMsg = Object.assign({}, msg, {
  query: { id: compositeId },
  payload: {
    $set: {
      ...record,
      "audit.version": 1,
      "audit.updatedAt": nowIso,
      "audit.lastEvent": auditEvent,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },
  },
  _recordForResponse: Object.assign({
    createdAt: nowIso,
    audit: {
      version: 1,
      updatedAt: nowIso,
      lastEvent: auditEvent,
      events: [auditEvent],
    },
  }, record),
});

const responseMsg = Object.assign({}, msg, {
  statusCode: 201,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: dbMsg._recordForResponse,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    compositeId,
    dedupeKey: compositeBooking.dedupeKey,
    status: record.status,
    paymentStatus: record.paymentStatus,
  },
});

return [dbMsg, responseMsg, debugMsg];
