const decision = msg._managedSubscriptionPolicyDecision;
const blockers = Array.isArray(decision?.blockers) ? decision.blockers : [];
msg.statusCode = 409;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};
msg.payload = {
  error: blockers[0]?.message || "Правила подписки не разрешили эту запись",
  details: {
    code: blockers[0]?.code || "MANAGED_SUBSCRIPTION_POLICY_BLOCKED",
    blockerCodes: blockers
      .map((item) => String(item?.code || "").trim())
      .filter(Boolean),
    policyVersion: Number.isInteger(decision?.policyVersion)
      ? decision.policyVersion
      : null,
  },
};
delete msg.error;
delete msg._managedSubscriptionPolicyInput;
return msg;
