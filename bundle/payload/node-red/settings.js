module.exports = {
  uiHost: "127.0.0.1",
  uiPort: 1882,
  flowFile: "flows.json",
  flowFilePretty: true,
  credentialSecret: false,
  disableEditor: true,
  httpAdminRoot: false,
  httpNodeRoot: "/",
  logging: {
    console: {
      level: "warn",
      metrics: false,
      audit: false,
    },
  },
  externalModules: {
    autoInstall: false,
  },
};
