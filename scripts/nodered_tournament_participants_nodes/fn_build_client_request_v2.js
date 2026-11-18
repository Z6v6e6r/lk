const participant = msg.payload || {};
const client = participant.client && typeof participant.client === 'object' ? { ...participant.client } : participant.client;
if (client) { delete client.phone; delete client.phoneNorm; delete client.mobile; }
msg.participant = { ...participant, client };
const id = String(client?.id || '').trim();
if (!id) { msg.payload = { ...msg.participant, rating: null, ratingSource: 'CUP_UNRATED' }; return [msg, null]; }
msg.payload = [{ $or: [{ clientId: id }, { 'identityAliases.clientIds': id }] }, { limit: 3, maxTimeMS: 5000 }];
delete msg.headers;
return [null, msg];
