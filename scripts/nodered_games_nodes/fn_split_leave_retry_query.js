const nowIso = new Date().toISOString();
const candidates = [
  {
    state: "VIVA_CONFIRMED",
    localApplyAttempts: { $lt: 20 },
    $or: [
      { localApplyLeaseUntil: { $exists: false } },
      { localApplyLeaseUntil: null },
      { localApplyLeaseUntil: { $lte: nowIso } },
    ],
  },
];
const serviceToken = String(global.get("vivacrm_access_token") || "").trim();
if (serviceToken) candidates.push({
  state: "RETURN_PENDING",
  returnVerificationAttempts: { $not: { $gte: 20 } },
  $or: [
    { localApplyLeaseUntil: { $exists: false } },
    { localApplyLeaseUntil: null },
    { localApplyLeaseUntil: { $lte: nowIso } },
  ],
});
const startedLease = [
  { claimLeaseUntil: { $exists: false } },
  { claimLeaseUntil: null },
  { claimLeaseUntil: { $lte: nowIso } },
];
candidates.push({
  state: "STARTED",
  vivaTargetMode: "NONE",
  recoveryAttempts: { $not: { $gte: 20 } },
  $or: startedLease,
});
if (serviceToken) candidates.push({
  state: "STARTED",
  vivaTargetMode: { $ne: "NONE" },
  recoveryAttempts: { $not: { $gte: 20 } },
  $or: startedLease,
});
msg.payload = {
  $or: candidates,
};
return msg;
