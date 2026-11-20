/** Run dependent ledger and projection writes on one Mongo snapshot. */
export function runRatingTransaction(db, apply) {
  // In-memory test databases provide collections without a Mongo client.
  if (!db.client) return apply(undefined);
  return db.client.withSession(session => session.withTransaction(() => apply(session), {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    readPreference: "primary",
  }));
}
