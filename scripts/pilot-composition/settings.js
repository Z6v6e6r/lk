module.exports = {
  flowFile: "flows.json",
  uiPort: Number(process.env.PORT || 1880),
  httpNodeRoot: "/",
  functionGlobalContext: {
    vivacrm_access_token: process.env.FIXTURE_ADMIN_TOKEN || "fixture.admin.token",
    vivacrm_token_expires_at: Date.now() + 24 * 3600 * 1000,
  },
  logging: { console: { level: "info", metrics: false, audit: false } },
  editorTheme: { projects: { enabled: false } },
  telemetry: false,
};