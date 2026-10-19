// monthly_tournament_write_guard_v1: capture before any round/params mutation.
const monthlyTournamentWriteSnapshot = {};
for (const field of MONTHLY_WRITE_FIELDS) {
  monthlyTournamentWriteSnapshot[field] = Object.prototype.hasOwnProperty.call(tournament, field)
    ? { value: field === '_id' || field.endsWith('At') ? tournament[field] : JSON.parse(JSON.stringify(tournament[field])) }
    : { missing: true };
}
