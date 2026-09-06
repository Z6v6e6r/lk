"use strict";

const fs = require("node:fs");
const path = require("node:path");
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
const CODES = new Set([
  "RAW_ACCEPTED", "RAW_BODY_SIZE", "RAW_JSON_INVALID", "RAW_JSON_COMPLEXITY", "RAW_JSON_DUPLICATE_KEY",
  "RAW_JSON_OBJECT_REQUIRED", "RAW_ROUTE_INVALID", "RAW_HEADERS_INVALID", "RAW_HEADERS_SIZE", "RAW_HEADER_DUPLICATE",
  "RAW_HOST_INVALID", "RAW_SECURITY_HEADER_INVALID", "RAW_CONTENT_TYPE_INVALID", "RAW_FRAMING_INVALID",
  "RAW_GUARD_ORDER_INVALID", "RAW_AUDIT_UNAVAILABLE", "RAW_BODY_TIMEOUT", "RAW_BODY_ABORTED", "RAW_BODY_IO_ERROR",
  "RAW_RESPONSE_CLOSED", "RAW_DELETE_BODY_INVALID", "RAW_GUARD_INTERNAL_ERROR",
]);
const fail = () => { throw new Error("RAW_AUDIT_STORAGE_UNAVAILABLE"); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const validEvent = (event) => event && Object.keys(event).sort().join(",") === "code,requestId,stage"
  && event.stage === "RAW_REQUEST_GUARD" && CODES.has(event.code)
  && typeof event.requestId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(event.requestId);

function openPartnerRawAudit({ directory, maxBytes = MAX_AUDIT_BYTES, io = fs } = {}) {
  const uid = process.getuid();
  if (typeof directory !== "string" || !path.isAbsolute(directory) || !Number.isSafeInteger(maxBytes)
    || maxBytes < 256 || maxBytes > MAX_AUDIT_BYTES) fail();
  const logPath = path.join(directory, "raw-requests.audit.jsonl");
  const lockPath = path.join(directory, "raw-requests.audit.lock");
  let parent;
  let lockFd;
  let lockStat;
  let fd;
  let fileStat;
  let size = 0;
  let failed = false;
  let closed = false;
  const assertFile = (stat) => {
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) fail();
  };
  const checkParent = () => {
    const current = io.lstatSync(directory);
    if (!current.isDirectory() || current.uid !== uid || (current.mode & 0o777) !== 0o700
      || io.realpathSync(directory) !== directory || (parent && !same(current, parent))) fail();
    return current;
  };
  const syncParent = () => {
    const dirFd = io.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (!same(io.fstatSync(dirFd), parent)) fail();
      io.fsyncSync(dirFd);
    } finally { io.closeSync(dirFd); }
  };
  const checkIdentity = () => {
    checkParent();
    const current = io.fstatSync(fd);
    const named = io.lstatSync(logPath);
    assertFile(current); assertFile(named);
    if (!same(current, fileStat) || !same(current, named) || current.size !== size) fail();
    const lock = io.lstatSync(lockPath);
    assertFile(lock);
    if (!same(lock, lockStat)) fail();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try { if (fd !== undefined) io.closeSync(fd); }
    finally {
      if (lockFd !== undefined) {
        io.closeSync(lockFd);
        checkParent();
        const named = io.lstatSync(lockPath);
        assertFile(named);
        if (!lockStat || !same(named, lockStat)) fail();
        io.unlinkSync(lockPath);
        syncParent();
      }
    }
  };
  try {
    parent = checkParent();
    lockFd = io.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    lockStat = io.fstatSync(lockFd);
    assertFile(lockStat);
    const lockBytes = Buffer.from(JSON.stringify({ formatVersion: 1, pid: process.pid }) + "\n");
    if (io.writeSync(lockFd, lockBytes) !== lockBytes.length) fail();
    io.fsyncSync(lockFd);
    syncParent();
    fd = io.openSync(logPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    fileStat = io.fstatSync(fd);
    assertFile(fileStat);
    if (fileStat.size > maxBytes) fail();
    size = fileStat.size;
    checkIdentity();
    const bytes = Buffer.alloc(size);
    if (size && io.readSync(fd, bytes, 0, size, 0) !== size) fail();
    const text = bytes.toString("utf8");
    if (size && !text.endsWith("\n")) fail();
    for (const line of text.split("\n").slice(0, -1)) {
      const record = JSON.parse(line);
      const { at, ...event } = record;
      if (!validEvent(event) || typeof at !== "string" || new Date(at).toISOString() !== at
        || JSON.stringify({ at, stage: event.stage, code: event.code, requestId: event.requestId }) !== line) fail();
    }
    io.fsyncSync(fd);
    syncParent();
    checkIdentity();
  } catch {
    failed = true;
    try { close(); } catch { /* do not delete an unconfirmed lock */ }
    fail();
  }
  const write = (event) => {
    if (closed || failed) return false;
    try {
      if (!validEvent(event)) fail();
      checkIdentity();
      const record = { at: new Date().toISOString(), stage: event.stage, code: event.code, requestId: event.requestId };
      const bytes = Buffer.from(JSON.stringify(record) + "\n");
      if (bytes.length > 512 || size + bytes.length > maxBytes) fail();
      if (io.writeSync(fd, bytes) !== bytes.length) fail();
      size += bytes.length;
      io.fsyncSync(fd);
      checkIdentity();
      return true;
    } catch { failed = true; return false; }
  };
  return Object.freeze({ write, close });
}

module.exports = { openPartnerRawAudit, MAX_AUDIT_BYTES };
