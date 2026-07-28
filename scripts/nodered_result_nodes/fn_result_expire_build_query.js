const nowTs = Date.now();
msg._resultExpire = { nowTs };
msg.payload = {
  status: 'CORRECTION_PENDING',
  deleted: { $ne: true },
  'correctionContext.expiresAtTs': { $lte: nowTs },
};
return [msg, msg];
