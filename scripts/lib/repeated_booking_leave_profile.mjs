// Explicit renderer for the existing production optimistic-CAS protocol.
// The shared membership-lock implementation remains unchanged.
export const LEGACY_CAS_PROFILE = 'production-legacy-cas-v1';
const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Leave profile source anchor drift');
  return source.replace(before, after);
};
export function renderLegacyLeaveFunction(file, source) {
  if (file === 'fn_split_leave_operation_route.js') {
    source = replaceOnce(source, `  ctx.subscriptionReturnState = null;
  ctx.refundMessage = operation.refundMessage || operation.successMessage || "Вы вышли из игры";
  msg.payload = { matchedCount: 1 };
  return [null, null, null, null, msg];`,
    `  return respond(200, "DONE", operation.refundMessage || operation.successMessage || "Вы вышли из игры");`);
    source = replaceOnce(source, `    ctx.subscriptionReturnState = "RETURN_PENDING";
    msg.payload = { matchedCount: 1 };
    return [null, null, null, null, msg];`,
    `    return respond(202, "RETURN_PENDING", "Вы вышли из игры. Возврат посещения проверяется");`);
  }
  if (file === 'fn_split_leave_game_update.js') {
    source = replaceOnce(source,
      `const query = { id: ctx.gameId, archived: { $ne: true }, "membershipMutation.operationKey": ctx.operationKey };
if (game.updatedAt !== undefined) query.updatedAt = game.updatedAt;`,
      `// Production legacy profile: exact optimistic CAS, never overwrite a new lock or organizer.
const query = { id: ctx.gameId, archived: { $ne: true }, membershipMutation: { $exists: false },
  updatedAt: game.updatedAt === undefined ? { $exists: false } : game.updatedAt,
  organizer: game.organizer === undefined ? { $exists: false } : game.organizer };`);
  }
  if (file === 'fn_split_leave_router.js') {
    source = replaceOnce(source,
      `if (ctx.localReconciliation && !["start_verify_active", "verify_active", "verify_history", "local_apply"].includes(ctx.step)) {`,
      `if (ctx.game && Object.prototype.hasOwnProperty.call(ctx.game, "membershipMutation")) {
  return fail(ctx, 409, "CONFLICT", "Состав игры изменяется. Обновите игру перед выходом.");
}
if (ctx.localReconciliation && !["start_verify_active", "verify_active", "verify_history", "local_apply"].includes(ctx.step)) {`);
  }
  return source;
}
