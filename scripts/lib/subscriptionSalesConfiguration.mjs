// Values are supplied by the separately published PM2 environment. The source
// candidate contains no enabled sales configuration and performs no activation.
export function loadSubscriptionSalesConfiguration(raw, globalContext) {
  const flags = {
    common: 'summer_subscription_sales_20260909_enabled',
    hub: 'summer_subscription_hub_lk1_sales_enabled',
    piter: 'summer_subscription_piter_next_day_sales_20260909_enabled',
    raClosed: 'summer_subscription_ra_admission_closed',
    friendshipClosed: 'summer_subscription_friendship_admission_closed',
  };
  // Disable the common transition before installing any dependent flags.
  globalContext.set(flags.common, false);
  globalContext.set(flags.hub, false); globalContext.set(flags.piter, false);
  globalContext.set('subscription_counter_epoch_started_at', null);
  let config;
  try {
    config = typeof raw === 'string' ? JSON.parse(raw) : null;
    const epoch = config?.kind === 'SUBSCRIPTION_SALES_CONFIGURATION_V2';
    const keys = ['kind', 'revision', 'common', 'hub', 'piter', 'raClosed', 'friendshipClosed', ...(epoch ? ['epochStartedAt'] : [])];
    if (!config || Object.keys(config).sort().join() !== keys.sort().join()
      || !['SUBSCRIPTION_SALES_CONFIGURATION_V1', 'SUBSCRIPTION_SALES_CONFIGURATION_V2'].includes(config.kind)
      || (epoch && (typeof config.epochStartedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(config.epochStartedAt)
        || !Number.isFinite(Date.parse(config.epochStartedAt)) || new Date(config.epochStartedAt).toISOString() !== config.epochStartedAt)) || !Number.isSafeInteger(config.revision) || config.revision < 1
      || Object.keys(flags).some(k => typeof config[k] !== 'boolean')) throw Error('configuration invalid');
  } catch {
    globalContext.set(flags.raClosed, true); globalContext.set(flags.friendshipClosed, true);
    const result = { kind: 'SUBSCRIPTION_SALES_CONFIGURATION_ATTESTATION_V1', valid: false, revision: null };
    globalContext.set('subscription_sales_configuration_attestation', result);
    return result;
  }
  if (config.kind === 'SUBSCRIPTION_SALES_CONFIGURATION_V2') globalContext.set('subscription_counter_epoch_started_at', config.epochStartedAt);
  for (const k of ['hub', 'piter', 'raClosed', 'friendshipClosed']) globalContext.set(flags[k], config[k]);
  globalContext.set(flags.common, config.common);
  const result = { kind: 'SUBSCRIPTION_SALES_CONFIGURATION_ATTESTATION_V1', valid: true,
    revision: config.revision, configuration: config };
  globalContext.set('subscription_sales_configuration_attestation', result);
  return result;
}

export function salesConfigurationInitializer() {
  return '\n// BEGIN subscription sales persistent configuration\n'
    + loadSubscriptionSalesConfiguration.toString()
    + '\nloadSubscriptionSalesConfiguration(env.get("PADLHUB_SUBSCRIPTION_SALES_CONFIGURATION"), global);\n'
    + '// END subscription sales persistent configuration\n';
}
