const task = msg._ratingLedgerProjectionTask;
delete msg._ratingLedgerProjectionTask;

if (!task || !msg._resultVivaSyncBatch) return null;

msg.payload = task;
return msg;
