/** Server-fixed academy policy. Request payloads never select tenant/collections. */
export const ACADEMY_TENANT_CONTRACT = {
  tenantKey: "005JDA",
  widgetUrl: "https://supadb.vivacrm.ru/storage/v1/object/public/widgets/1ef6433f-a5de-4a77-9784-73be90273f59.js",
  namespace: "/lk/analytics/academy-005JDA",
  documentSetVersion: "2026-11-10-rodina",
  documents: [
    { id: "public-offer", title: "Правила оказания услуг", version: "2026-11-10", url: "https://cg178013.tw1.ru/docs/service-rules.pdf" },
    { id: "personal-data-policy", title: "Политика обработки персональных данных", version: "2026-11-10", url: "https://cg178013.tw1.ru/docs/privacy-policy.pdf" },
  ],
  collections: {
    consents: "academy_005JDA_auth_consents",
    communities: "academy_005JDA_communities",
    push: "academy_005JDA_push_tokens",
    analytics: "academy_005JDA_analytics",
  },
} as const;
