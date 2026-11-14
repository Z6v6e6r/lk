// Daily-visit takeover from an owner this same request proved cancelled in its usage
// step (cancelled_hold.js). The owner must be byte-identical to the proven document
// and the proof at most 60 s old; anything else keeps the ordinary rejection.
const lk1CancelledHoldVerified = (ctx, owner) => {
  const proof = ctx?.lk1CancelledHolds?.[owner?._id];
  const age = Date.now() - Number(proof?.observedAt);
  return owner?.state === "CONFIRMED" && typeof proof?.owner === "string"
    && proof.owner === JSON.stringify(owner) && age >= 0 && age <= 60000;
};
