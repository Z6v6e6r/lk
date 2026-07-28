const operation = msg._ratingLedgerStateOperation;
if (!operation?.query || !operation?.update) {
  node.error('Missing canonical player rating state operation after ledger append', msg);
  return null;
}

const setDoc = operation.update.$set && typeof operation.update.$set === 'object'
  ? operation.update.$set
  : null;
const setOnInsertDoc = operation.update.$setOnInsert && typeof operation.update.$setOnInsert === 'object'
  ? operation.update.$setOnInsert
  : null;
if (setDoc && setOnInsertDoc) {
  for (const key of Object.keys(setOnInsertDoc)) {
    if (Object.prototype.hasOwnProperty.call(setDoc, key)) delete setOnInsertDoc[key];
  }
}

msg.payload = [operation.query, operation.update, { upsert: true }];
msg._ratingLedgerCompatibilityOperation = {
  query: operation.query,
  update: operation.update,
};
delete msg._ratingLedgerStateOperation;
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
