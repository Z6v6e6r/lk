const item = msg.payload;
if (!item || typeof item !== 'object') return null;
msg.payload = [item.query, item.update, { upsert: true }];
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
