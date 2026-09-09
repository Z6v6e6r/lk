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
  let config;
  try {
    config = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (!config || Object.keys(config).sort().join() !== ['kind', 'revision', 'common', 'hub', 'piter', 'raClosed', 'friendshipClosed'].sort().join()
      || config.kind !== 'SUBSCRIPTION_SALES_CONFIGURATION_V1' || !Number.isSafeInteger(config.revision) || config.revision < 1
      || Object.keys(flags).some(k => typeof config[k] !== 'boolean')) throw Error('configuration invalid');
  } catch {
    globalContext.set(flags.raClosed, true); globalContext.set(flags.friendshipClosed, true);
    const result = { kind: 'SUBSCRIPTION_SALES_CONFIGURATION_ATTESTATION_V1', valid: false, revision: null };
    globalContext.set('subscription_sales_configuration_attestation', result);
    return result;
  }
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
