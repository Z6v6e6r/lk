'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const FILE = '/etc/phab-traffic/max-media-integration.json';
const need = (value, code) => { if (!value) throw Error(code); };

// Loaded when the adapter is hot-registered. Only the media token and exact S3
// delivery hosts enter Node-RED; storage credentials and the signing key do not.
function loadSupportMediaConfig({ file = FILE, environment = process.env, uid = process.getuid() } = {}) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return false; throw Error('MAX_MEDIA_CONFIG_UNAVAILABLE'); }
  try {
    const before = fs.fstatSync(fd), parent = path.dirname(file), dir = fs.lstatSync(parent);
    need(before.isFile() && before.uid === uid && before.nlink === 1 && (before.mode & 0o7777) === 0o600
      && before.size > 0 && before.size <= 2048, 'MAX_MEDIA_CONFIG_CUSTODY');
    need(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === uid && !(dir.mode & 0o022)
      && fs.realpathSync(parent) === parent, 'MAX_MEDIA_CONFIG_DIRECTORY');
    const buffer = Buffer.alloc(2049), size = fs.readSync(fd, buffer, 0, 2049, 0);
    need(size === before.size && buffer.subarray(0, size).every(byte => byte < 128), 'MAX_MEDIA_CONFIG_ENCODING');
    let config;
    try { config = JSON.parse(buffer.subarray(0, size).toString('ascii')); }
    catch { throw Error('MAX_MEDIA_CONFIG_FORMAT'); }
    need(config && !Array.isArray(config) && Object.keys(config).sort().join(',') === 'mediaToken,sourceHosts'
      && typeof config.mediaToken === 'string' && /^[a-f0-9]{64}$/.test(config.mediaToken)
      && Array.isArray(config.sourceHosts) && config.sourceHosts.length >= 1 && config.sourceHosts.length <= 4
      && new Set(config.sourceHosts).size === config.sourceHosts.length
      && config.sourceHosts.every(host => typeof host === 'string' && host.length <= 253 && !isIP(host)
        && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)), 'MAX_MEDIA_CONFIG_FORMAT');
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink'].every(k => a[k] === b[k]);
    need(same(before, after) && same(after, current), 'MAX_MEDIA_CONFIG_CHANGED');
    const values = { SUPPORT_MEDIA_INTEGRATION_TOKEN: config.mediaToken,
      SUPPORT_MAX_MEDIA_SOURCE_HOSTS: config.sourceHosts.join(',') };
    need(Object.entries(values).every(([key, value]) => !Object.hasOwn(environment, key) || environment[key] === value),
      'MAX_MEDIA_CONFIG_ENV_CONFLICT');
    Object.assign(environment, values);
    return true;
  } finally { fs.closeSync(fd); }
}
module.exports = { loadSupportMediaConfig };
