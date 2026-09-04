"use strict";

const path = require("node:path");

module.exports = {
  uiHost: "127.0.0.1",
  uiPort: 18894,
  httpNodeRoot: "/",
  httpAdminRoot: false,
  disableEditor: true,
  credentialSecret: false,
  flowFilePretty: true,
  nodesDir: path.resolve(__dirname, "../runtime/node_modules/@padlhub/node-red-partner-game-membership-api"),
  contextStorage: {
    default: { module: "memory" },
  },
  externalModules: {
    autoInstall: false,
    palette: {
      allowInstall: false,
      allowUpload: false,
    },
    modules: {
      allowInstall: false,
    },
  },
  logging: {
    console: {
      level: "info",
      metrics: false,
      audit: false,
    },
  },
};
