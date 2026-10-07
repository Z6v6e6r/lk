// monthly_tournament_create_guard_v1: closed root wins over a stale create/recreate.
msg._tournamentGuardedUpsert = true;
msg.payload = [msg.query, [{ $replaceWith: { $cond: [MONTHLY_CLOSED_EXPRESSION, '$$ROOT', { $mergeObjects: ['$$ROOT', { $literal: msg.payload.$set }, { createdAt: { $ifNull: ['$createdAt', { $literal: msg.payload.$setOnInsert.createdAt }] } }] }] } }]];
