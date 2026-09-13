  // Only the explicit organizer cancellation is forbidden here; scheduler policy stays separate.
  const organizerId = normalizeComparableId(game.organizer?.id || game.organizer?.clientId || metadata.organizerId);
  const organizerPhone = normalizePhone(game.organizer?.phoneNorm || game.organizer?.phone || metadata.organizerPhoneNorm);
  const otherActive = [...participants, ...waitlist, ...payments].some((item) => {
    if (/CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|CLOSE|ARCHIVE|LEFT|REMOV/i.test(String(item.status || ""))) return false;
    const memberId = normalizeComparableId(item.clientId || item.playerId || item.userId || item.id);
    if (memberId && organizerId) return memberId !== organizerId;
    const memberPhone = normalizePhone(item.phoneNorm || item.phone || item.clientPhoneNorm || item.clientPhone);
    return !memberPhone || !organizerPhone || memberPhone !== organizerPhone;
  });
  if (explicitForceTarget && (otherActive || (game.membershipMutation
    && game.membershipMutation.operationKey !== `cancel:${gameId}:${normalizeComparableId(request.actorClientId)}`))) {
    authorizationFailure = { code: "ORGANIZER_TRANSFER_REQUIRED",
      error: "Перед отменой участия передайте роль организатора другому игроку. Игра не может быть отменена." };
    return;
  }
