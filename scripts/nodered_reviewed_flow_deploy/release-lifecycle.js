// Install as a Node-RED nodesDir plugin before flows start. No routes or credentials.
module.exports = function registerReleaseLifecycle(RED) {
  require('./lifecycle.cjs').attach(RED, RED.settings.get('padlhubReleaseLifecycle'));
};
