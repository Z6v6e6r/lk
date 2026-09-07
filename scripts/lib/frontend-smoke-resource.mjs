// Both exact HTTPS names belong to the reviewed reserve DEV vhost.
const DEV_ORIGINS = new Set([
  'https://lk-reserve.tsup.space',
  'https://lk-reserve.89-108-64-209.sslip.io',
]);

export function expectedEntryResource(value, channel, version) {
  const resource = new URL(value);
  if (resource.pathname !== (channel === 'dev' ? '/lk/bundle-dev.js' : '/lk/bundle.js')
    || (channel === 'dev' && !DEV_ORIGINS.has(resource.origin))
    || resource.searchParams.get('v') !== version) return null;
  // Never return full queries, credentials or unrelated resource entries.
  return { origin: resource.origin, path: resource.pathname, v: resource.searchParams.get('v') };
}
