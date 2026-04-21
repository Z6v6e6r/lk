const tournament = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
if (!tournament) {
  msg.statusCode = 404;
  msg.payload = { error: "Tournament not found" };
  return msg;
}

const format = String(msg.req?.query?.format || "csv").toLowerCase();
const nameById = {};
(tournament.participants || []).forEach((participant, index) => {
  const id = participant?.id || participant?.phone || `p-${index + 1}`;
  nameById[id] = participant?.name || `Участник ${index + 1}`;
});

const historyRows = [];
const logs = tournament.playerLogs || {};
Object.keys(logs).forEach((playerId) => {
  (logs[playerId] || []).forEach((entry) => {
    historyRows.push({
      playerId,
      playerName: nameById[playerId] || "",
      roundId: entry.roundId,
      matchId: entry.matchId,
      scoreFor: entry.scoreFor,
      scoreAgainst: entry.scoreAgainst,
      delta: entry.delta,
      ratingBefore: entry.ratingBefore,
      ratingAfter: entry.ratingAfter,
      expected: entry.expected,
      actual: entry.actual,
    });
  });
});

const standingsRows = Array.isArray(tournament.standings)
  ? tournament.standings.map((row) => ({
      rank: row.rank,
      playerId: row.id,
      playerName: row.name,
      matchesPlayed: row.matchesPlayed,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      playedPoints: row.playedPoints,
      byeCount: row.byeCount,
      byePoints: row.byePoints,
      totalPoints: row.totalPoints ?? row.tournamentPoints,
      pointsFor: row.pointsFor,
      pointsAgainst: row.pointsAgainst,
      pointDiff: row.pointDiff,
      ratingBefore: row.ratingBefore,
      ratingAfter: row.ratingAfter,
      ratingDelta: row.ratingDelta ?? row.deltaTotal,
    }))
  : [];

if (format === "xlsx") {
  const XLSX = global.get("XLSX");
  if (!XLSX) {
    msg.statusCode = 501;
    msg.payload = { error: "XLSX module not installed. Use format=csv or install xlsx" };
    return msg;
  }

  const workbook = XLSX.utils.book_new();
  const standingsSheet = XLSX.utils.json_to_sheet(
    standingsRows.length > 0 ? standingsRows : [{ message: "No standings available" }],
  );
  XLSX.utils.book_append_sheet(workbook, standingsSheet, "standings");

  const historySheet = XLSX.utils.json_to_sheet(
    historyRows.length > 0 ? historyRows : [{ message: "No history available" }],
  );
  XLSX.utils.book_append_sheet(workbook, historySheet, "history");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  msg.headers = {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": "attachment; filename=americano-history.xlsx",
  };
  msg.payload = buffer;
  return msg;
}

const rows = historyRows;
const escapeCsv = (value) => {
  const normalized = String(value ?? "");
  if (normalized.includes(",") || normalized.includes("\"") || normalized.includes("\n")) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }
  return normalized;
};

const header = Object.keys(
  rows[0] || {
    playerId: "",
    playerName: "",
    roundId: "",
    matchId: "",
    scoreFor: "",
    scoreAgainst: "",
    delta: "",
    ratingBefore: "",
    ratingAfter: "",
    expected: "",
    actual: "",
  },
);
const csv = [header.join(",")]
  .concat(rows.map((row) => header.map((key) => escapeCsv(row[key])).join(",")))
  .join("\n");

msg.headers = {
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": "attachment; filename=americano-history.csv",
};
msg.payload = csv;
return msg;
