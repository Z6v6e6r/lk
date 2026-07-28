const CIRCUIT_KEY = "lkTournamentParticipantVivaCircuitV2";
const current = flow.get(CIRCUIT_KEY) || { failures: 0, openedUntil: 0 };
const failures = Number(current.failures || 0) + 1;
flow.set(CIRCUIT_KEY, {
  failures,
  openedUntil: failures >= 2 ? Date.now() + 30_000 : 0,
});

msg.statusCode = 502;
msg.payload = { error: "Participants temporarily unavailable" };
return msg;
