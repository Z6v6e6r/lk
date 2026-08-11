const rows = Array.isArray(msg.payload) ? msg.payload : [];
const tournament = rows.find((row) => row && typeof row === "object" && !Array.isArray(row)) || null;
const tournamentId = String(
  tournament?.tournamentId || tournament?.exerciseId || tournament?.sourceTournamentId || tournament?.id || "",
).trim();

msg._tournamentCommunityContext = {
  mode: String(msg._tournamentCommunityMode || "history"),
  sourceRows: rows,
  tournamentId: tournamentId || null,
};
delete msg._tournamentCommunityMode;
msg.payload = tournamentId
  ? {
      archived: { $ne: true },
      kind: "TOURNAMENT",
      $or: [
        { relatedTournamentId: tournamentId },
        { tournamentId },
        { "details.relatedTournamentId": tournamentId },
        { "details.publicTournament.exerciseId": tournamentId },
        { "details.publicTournament.tournamentId": tournamentId },
      ],
    }
  : { _id: { $exists: false } };
return msg;
