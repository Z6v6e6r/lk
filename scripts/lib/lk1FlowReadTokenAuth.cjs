'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVICE_TOKEN_FILE = '/etc/padlhub/lk1-unpaid-cancel-guard/service.token';
const SERVICE_USERNAME = 'lk1-unpaid-cancel-guard';
const SERVICE_PERMISSION = 'flows.read';

// Supported Node-RED adminAuth.tokens hook. This never creates/caches a session.
// A missing or unsafe file denies this service only; editor authentication stays intact.
function createFlowReadTokenAuth(tokenFile = SERVICE_TOKEN_FILE) {
  if (!path.isAbsolute(tokenFile)) throw new Error('SERVICE_TOKEN_PATH_INVALID');
  return async function tokens(candidate) {
    if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) return null;
    let fd;
    try {
      const directory = path.dirname(tokenFile), stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory) return null;
      fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const file = fs.fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid()
        || (file.mode & 0o777) !== 0o600 || file.size < 64 || file.size > 65) return null;
      const raw = fs.readFileSync(fd, 'utf8');
      if (!/^[a-f0-9]{64}\n?$/.test(raw)) return null;
      const digest = value => crypto.createHash('sha256').update(value).digest();
      if (!crypto.timingSafeEqual(digest(candidate), digest(raw.trim()))) return null;
      return { username: SERVICE_USERNAME, permissions: SERVICE_PERMISSION };
    } catch { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
}

module.exports = { createFlowReadTokenAuth, SERVICE_TOKEN_FILE, SERVICE_USERNAME, SERVICE_PERMISSION };
