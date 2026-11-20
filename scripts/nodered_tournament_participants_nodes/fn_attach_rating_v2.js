const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length > 1 || (rows[0] && (rows[0].ownership !== 'CUP_CANONICAL' || typeof rows[0].ratingNumeric !== 'number' || !Number.isFinite(rows[0].ratingNumeric) || rows[0].ratingNumeric < 1 || rows[0].ratingNumeric > 7))) {
  node.error('Canonical tournament participant level is inconsistent', msg); return null;
}
msg.payload = { ...(msg.participant || {}), rating: rows[0] ? rows[0].ratingNumeric.toFixed(5) : null,
  ratingSource: rows[0] ? 'CUP_CANONICAL' : 'CUP_UNRATED' };
return msg;
