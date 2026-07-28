const context = msg._tournamentBroadcast || {};
msg.statusCode = 200;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};
msg.payload = {
  ok: true,
  tournamentId: context.tournamentId || null,
  stationId: context.stationId || null,
  active: context.action === "start",
  updatedAt: context.updatedAt || null,
};
return msg;
