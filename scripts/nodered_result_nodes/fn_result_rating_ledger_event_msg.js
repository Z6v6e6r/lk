const item = msg.payload;
const operation = item?.eventOperation;
const stateOperation = item?.stateOperation;

if (!operation?.query || !operation?.update?.$setOnInsert || !stateOperation?.query || !stateOperation?.update) {
  node.error('Invalid canonical rating ledger mutation', msg);
  return null;
}

msg._ratingLedgerStateOperation = stateOperation;
msg._ratingLedgerEventId = item.eventId || operation.update.$setOnInsert.id || null;
msg._ratingLedgerProjectionTask = item.projectionTask || null;
msg.payload = [operation.query, operation.update, { upsert: true }];
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
