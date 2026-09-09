// Exact, local source transformation shared by new preview builds and the
// focused update of an already installed HUB gateway. No runtime I/O.
export function replaceInstanceLimitAnchor(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Subscription instance limit source drift');
  return source.replace(before, after);
}
const providerIdentityGuard = `  // Resolve membership before filtering: an incomplete/conflicting provider row
  // cannot prove that the selected subscription still has unused allowance.
  const relevantBookings = ctx.lk1.activeBookings.concat(ctx.lk1.bookings.filter((booking) =>
    !isInactiveBooking(booking) && (!eventDate(booking) || eventDate(booking) === ctx.serviceDate)));
  for (const booking of relevantBookings) {
    const aliases = [booking.clientSubscriptionId, booking.subscriptionId, booking.clientSubId];
    for (const nested of [booking.subscription, booking.clientSubscription]) {
      if (isObj(nested)) aliases.push(nested.clientSubscriptionId, nested.subscriptionId, nested.id, nested.uuid);
    }
    const present = aliases.filter((value) => value !== undefined && value !== null && value !== "");
    const ids = new Set(present.map(normalizeId).filter(Boolean));
    const paidBySubscription = [booking.paymentType, booking.paymentMethod]
      .some((value) => String(value || "").trim().toUpperCase() === "SUBSCRIPTION");
    if (present.some((value) => typeof value !== "string") || ids.size > 1
      || (paidBySubscription && ids.size !== 1)) return lk1Stop(ctx, "LK1_BOOKING_SUBSCRIPTION_ID_UNRESOLVED");
    if (ids.has(normalizeId(ctx.clientSubscriptionId)) && !eventDate(booking)) {
      return lk1Stop(ctx, "LK1_BOOKING_DATE_UNRESOLVED");
    }
  }
`;

export function scopeSubscriptionUsage(source) {
  let result = replaceInstanceLimitAnchor(source,
    '  let used = 0;\n  const coveredBookings',
    providerIdentityGuard + '  let used = 0;\n  const coveredBookings');
  result = replaceInstanceLimitAnchor(result,
    '    if (["FAILED", "RELEASED"].includes(operation.state)) continue;',
    '    if (!normalizeId(operation.clientSubscriptionId)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");\n'
    + '    if (normalizeId(operation.clientSubscriptionId) !== normalizeId(ctx.clientSubscriptionId)) continue;\n'
    + '    if (["FAILED", "RELEASED"].includes(operation.state)) continue;');
  result = replaceInstanceLimitAnchor(result,
    '      || coveredBookings.has(normalizeId(bookingId(booking))) || resolveCategory(booking) !== "open_game") continue;',
    '      || coveredBookings.has(normalizeId(bookingId(booking)))) continue;\n'
    + '    const category = resolveCategory(booking);\n'
    + '    if (!category) return lk1Stop(ctx, "LK1_BOOKING_CATEGORY_UNRESOLVED");\n'
    + '    if (category !== "open_game") continue;');
  result = replaceInstanceLimitAnchor(result, '  const active = ctx.lk1.activeBookings;',
    '  const active = ctx.lk1.activeBookings.filter((booking) =>\n'
    + '    normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId));');
  return replaceInstanceLimitAnchor(result, 'activeServiceScope: "ALL_BOOKINGS"',
    'activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY"');
}
export function scopeSubscriptionEvaluator(source) {
  return replaceInstanceLimitAnchor(replaceInstanceLimitAnchor(source,
    'usage.activeServiceScope !== "ALL_BOOKINGS"', 'usage.activeServiceScope !== "SUBSCRIPTION_BENEFIT_ONLY"'),
    'Полный список активных записей Viva не подтверждён', 'Активные записи выбранной подписки не подтверждены');
}
