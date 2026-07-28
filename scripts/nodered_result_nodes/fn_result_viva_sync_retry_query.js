msg.payload = {
  kind: 'VIVA_ONBOARDING_LEVEL',
  status: 'FAILED',
  retryable: { $ne: false },
  attempts: { $lt: 30 },
};
return [msg, msg];
