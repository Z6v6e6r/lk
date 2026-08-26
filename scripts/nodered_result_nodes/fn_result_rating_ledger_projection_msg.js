const task = msg._ratingLedgerProjectionTask;
delete msg._ratingLedgerProjectionTask;

if (!task || !msg._resultVivaSyncBatch) return null;

msg.payload = task;
if (task._legacyResultSideEffect) msg._legacyResultSideEffect = task._legacyResultSideEffect;
return msg;
