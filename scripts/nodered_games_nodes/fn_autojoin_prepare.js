// Membership is now projected from persisted events by communityPolicyProjection.
// Missing communityType stays FRIENDS and must never trigger station enrollment.
msg.payload = { ok: true, reason: 'DEFERRED_TO_COMMUNITY_POLICY' };
return [null, msg];
