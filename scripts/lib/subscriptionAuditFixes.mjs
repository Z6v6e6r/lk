// Pure source transformations. No network, provider calls, or state mutation.
export const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Subscription audit source anchor drift');
  return source.replace(before, after);
};

export function normalizeServiceDateMoscow(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,6})?)?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/.exec(text);
  if (!parts) return null;
  const calendar = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== text.slice(0, 10)) return null;
  if (!parts[4] || !parts[7]) return text.slice(0, 10); // Viva local calendar/time is Moscow.
  const instant = new Date(text.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  if (!Number.isFinite(instant.getTime())) return null;
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = type => formatted.find(row => row.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function patchServiceDate(source) {
  const start = source.indexOf('const eventDate = (value) => {');
  const end = source.indexOf('\n};', start) + 3;
  if (start < 0 || end <= start || source.includes('function normalizeServiceDateMoscow(')) throw new Error('Service date source drift');
  const old = source.slice(start, end);
  const changed = old.replaceAll('normalizeDate(', 'normalizeServiceDateMoscow(');
  if (changed === old) throw new Error('Service date anchor drift');
  return replaceOnce(source, old, normalizeServiceDateMoscow.toString() + '\n' + changed);
}

// An upstream-only marker is not confirmation. Deduplicate only a FREE claim
// against one independently observed, matching SUBSCRIPTION booking; never write
// a repaired binding or remove its reservation here.
export const bindingBlock = `    // AUDIT_BINDING_START
    const aliases = [operation.bookingId, operation.upstreamBookingId]
      .filter(value => value !== undefined && value !== null && value !== "");
    if (aliases.some(value => typeof value !== "string" || !normalizeId(value))
      || new Set(aliases.map(normalizeId)).size > 1) return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
    let coveredId = normalizeId(operation.bookingId);
    if (!coveredId && normalizeId(operation.upstreamBookingId)) {
      const upstreamId = normalizeId(operation.upstreamBookingId);
      const matches = ctx.lk1.bookings.filter(booking => !isInactiveBooking(booking)
        && normalizeId(bookingId(booking)) === upstreamId);
      if (matches.length > 1) return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_AMBIGUOUS");
      if (matches.length === 1) {
        const booking = matches[0];
        const owners = [booking.clientId, booking.actorClientId, booking.profileId, booking.client?.id]
          .filter(value => value !== undefined && value !== null && value !== "");
        const exerciseIds = [booking.exerciseId, booking.exercise?.id, booking.exercise?.exerciseId]
          .filter(value => value !== undefined && value !== null && value !== "");
        if (owners.some(value => typeof value !== "string" || normalizeId(value) !== normalizeId(ctx.actorClientId))
          || !normalizeId(operation.exerciseId) || !exerciseIds.length
          || exerciseIds.some(value => typeof value !== "string" || normalizeId(value) !== normalizeId(operation.exerciseId))
          || eventDate(booking) !== operation.serviceDate
          || normalizeId(bookingSubscriptionId(booking)) !== normalizeId(operation.clientSubscriptionId)) {
          return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
        }
        const decision = operation.lk1.decision;
        if (decision.benefit?.finalPriceMinor === 0 && decision.subscriptionVisitCount === 1
          && decision.gameMinutes?.paidOverageMinutes === 0
          && decision.gameMinutes?.freeMinutes > 0
          && String(booking.paymentType || booking.paymentMethod || "").toUpperCase() === "SUBSCRIPTION") {
          const duration = eventDurationMinutes(booking.exercise || booking);
          const free = decision.gameMinutes.freeMinutes;
          if (!Number.isSafeInteger(free) || free !== duration || free > ctx.lk1.rule.freeGameMinutesPerDay
            || (operation.lk1.target?.durationMinutes !== undefined && operation.lk1.target.durationMinutes !== duration)) {
            return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
          }
          coveredId = upstreamId;
        }
      }
    }
    // AUDIT_BINDING_END`;

export function patchUsageBindings(source) {
  let result = replaceOnce(source,
    '    if (operation.bookingId) benefitBookings.add(normalizeId(operation.bookingId));',
    bindingBlock + '\n    if (coveredId) benefitBookings.add(coveredId);');
  result = replaceOnce(result,
    '    if (operation.bookingId) coveredBookings.add(normalizeId(operation.bookingId));',
    '    if (coveredId) coveredBookings.add(coveredId);');
  return replaceOnce(result, 'activeServices: active.length,',
    'activeServices: new Set(active.map(booking => normalizeId(bookingId(booking)))).size,');
}

export function patchLeaveRead(source) {
  const old = 'const rows = asArray(msg.payload).filter(isObj);';
  const guard = 'if (msg.error || !Array.isArray(msg.payload) || !msg.payload.every(isObj)) return retry(ctx, "daily_limit_read_unavailable");';
  return replaceOnce(source, old, guard + '\nconst rows = msg.payload;');
}
