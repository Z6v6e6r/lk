const operation = msg._ratingLedgerCompatibilityOperation;
delete msg._ratingLedgerCompatibilityOperation;

if (!operation?.query || !operation?.update) {
  node.error('Missing player_ratings compatibility projection operation', msg);
  return null;
}

const update = Object.assign({}, operation.update, {
  $set: Object.assign({}, operation.update.$set || {}, {
    compatibilityProjection: true,
    canonicalCollection: 'player_rating_state',
    compatibilityUpdatedAt: new Date().toISOString(),
  }),
});
msg.payload = [operation.query, update, { upsert: true }];
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
