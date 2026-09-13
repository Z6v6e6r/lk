msg._organizerGuardBody = msg.payload;
msg.payload = { id: String(msg.req?.params?.gameId || "").trim() };
return msg;
