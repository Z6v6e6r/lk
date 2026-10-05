if (msg.mongoQuery && msg.mongoUpdate) {
  msg.mongoQuery = { ...msg.mongoQuery, $and: Object.entries(monthlyTournamentWriteSnapshot).map(([field, state]) => state.missing ? { [field]: { $exists: false } } : { [field]: { $eq: state.value } }) };
}
