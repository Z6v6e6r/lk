'use strict';
const fs = require('node:fs');
const path = require('node:path');
const KEY = 'SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN';
const FILE = '/etc/phab-traffic/max-outbox-integration.env';
const need = (value, code) => { if (!value) throw Error(code); };

/** Optional server-only bootstrap. Never put the credential in node/flow config. */
function loadIntegrationConfig({ file = FILE, environment = process.env, uid = process.getuid() } = {}) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return false; throw Error('MAX_INTEGRATION_FILE_UNAVAILABLE'); }
  try {
    const before = fs.fstatSync(fd), parent = path.dirname(file), dir = fs.lstatSync(parent);
    need(before.isFile() && before.uid === uid && before.nlink === 1 && (before.mode & 0o7777) === 0o600
      && before.size > 0 && before.size <= 128, 'MAX_INTEGRATION_FILE_CUSTODY');
    need(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === uid && !(dir.mode & 0o022)
      && fs.realpathSync(parent) === parent, 'MAX_INTEGRATION_DIRECTORY_CUSTODY');
    const buffer = Buffer.alloc(129), size = fs.readSync(fd, buffer, 0, 129, 0);
    const text = buffer.subarray(0, size).toString('ascii');
    need(size === before.size && Buffer.from(text, 'ascii').equals(buffer.subarray(0, size))
      && new RegExp('^' + KEY + '=[a-f0-9]{64}\\n$').test(text), 'MAX_INTEGRATION_FILE_FORMAT');
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].every(k => a[k] === b[k]);
    need(same(before, after) && same(after, current), 'MAX_INTEGRATION_FILE_CHANGED');
    const value = text.slice(KEY.length + 1, -1);
    need(!Object.hasOwn(environment, KEY) || environment[KEY] === value, 'MAX_INTEGRATION_ENV_CONFLICT');
    environment[KEY] = value;
    return true;
  } finally { fs.closeSync(fd); }
}
module.exports = { loadIntegrationConfig };
