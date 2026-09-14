// One bounded batch, no Split message clones and no unbounded Delay queue.
// Rejected overlapping ticks are retried from durable Mongo eligibility next tick.
const jobs = Array.isArray(msg.payload) ? msg.payload : [];
if (context.get('batchActive') || !jobs.length) return null;
context.set('batchActive', true);
const batch = jobs.slice(0, 60);
let cursor = 0;
const sendNext = () => {
  const record = batch[cursor++];
  // Carry only the selected record, never the complete query/ledger batch.
  node.send({ payload: record });
  if (cursor < batch.length) setTimeout(sendNext, 1000);
  else { context.set('batchActive', false); node.done(); }
};
sendNext();
return null;
