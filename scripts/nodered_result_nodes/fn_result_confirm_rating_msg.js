const item = msg.payload;
if (!item || typeof item !== 'object') return null;
msg.query = item.query;
msg.payload = item.update;
return msg;
