'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');

const directory = '/opt/padlhub/lk147-node-red-launcher';
const graph = '/root/.node-red/flows.json';
const credential = '/etc/padlhub/lk147-tournament-owner/integration.token';
const retainedEnvFiles = [
  '/etc/phab-traffic/subscriptions-residency-node-red.env',
  '/etc/phab-traffic/subscriptions-residency-node-red-flags.env',
];
// This admission is scoped to the exact reviewed RA #497 graph on 147.
const ra497Sha256 = '83b9182d12e206a05051d2c666743cbdb8c6f6bfdd48e946bed72a4fa6eaaa08';
// The LK1 retry release changes only the subscription booking router and finalizer.
const genderRetrySha256 = '6812c12a5d51fa51713a9b368353dd2ab5afe2110889c3fa9a8e0c82dd4d6da7';
// CUP staff leave extends only the exact reviewed primary LK1 graph.
const cupStaffLeaveSha256 = '704bf9e3cf3392a47aca5c5bf5cc66c1acf3d7a755cf5da5f7cb3ffecff05c2d';
const shaPattern = /^[a-f0-9]{64}$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const refuse = (code) => { throw new Error(code); };

function readProtected(filename, { privateFile, privateDirectory = privateFile, limit }) {
  const parent = path.dirname(filename);
  const root = fs.lstatSync(parent);
  if (!root.isDirectory() || root.uid !== 0 || fs.realpathSync(parent) !== parent
    || (root.mode & (privateDirectory ? 0o077 : 0o022))) refuse('DIRECTORY_NOT_PROTECTED');

  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const unsafePermissions = BigInt(privateFile ? 0o077 : 0o022);
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n
      || (before.mode & unsafePermissions) || before.size < 1n || before.size > BigInt(limit)) refuse('FILE_NOT_PROTECTED');
    const bytes = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, null);
      if (count === 0) refuse('FILE_CHANGED_WHILE_READING');
      read += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const linked = fs.lstatSync(filename, { bigint: true });
    if (!stable(before, after) || !linked.isFile() || !stable(after, linked)) refuse('FILE_CHANGED_WHILE_READING');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

const pilotEnvKeys = [
  'LK_RESIDENCY_LIFECYCLE_ENABLED',
  'LK_RESIDENCY_LIFECYCLE_PREVIEW_ONLY',
  'LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED',
  'LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE',
  'LK_RESIDENCY_LIFECYCLE_PILOT_USERS',
  'LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG',
  'LK_RESIDENCY_LIFECYCLE_ENSURE_INDEXES',
  'LK_RESIDENCY_LIFECYCLE_MONGO_URI',
  'LK_RESIDENCY_LIFECYCLE_MONGO_DB',
  'LK_RESIDENCY_LIFECYCLE_CUP_API_URL',
  'LK_RESIDENCY_LIFECYCLE_CUP_INTEGRATION_TOKEN',
  'LK_RESIDENCY_LIFECYCLE_ALLOW_ORIGIN',
  'LK_RESIDENCY_LIFECYCLE_PILOT_CONTROL_FILE',
].sort().join(',');

function verifyPilotEnv(expectedSha256) {
  const raw = readProtected(path.join(directory, 'residency-preview.env'), { privateFile: true, limit: 16384 });
  if (sha256(raw) !== expectedSha256) refuse('PILOT_ENV_HASH_MISMATCH');
  const env = parseEnv(raw.toString('utf8'));
  raw.fill(0);
  if (Object.keys(process.env).some((name) => name.startsWith('LK_RESIDENCY_LIFECYCLE_'))) {
    refuse('PILOT_ENV_INHERITED_OVERRIDE');
  }
  if (Object.keys(env).sort().join(',') !== pilotEnvKeys
    || env.LK_RESIDENCY_LIFECYCLE_ENABLED !== 'true'
    || env.LK_RESIDENCY_LIFECYCLE_PREVIEW_ONLY !== 'true'
    || env.LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED !== 'false'
    || env.LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE !== 'pilot'
    || env.LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG !== 'false'
    || env.LK_RESIDENCY_LIFECYCLE_ENSURE_INDEXES !== 'false'
    || env.LK_RESIDENCY_LIFECYCLE_MONGO_DB !== 'games'
    || !/^mongodb(?:\+srv)?:\/\//.test(env.LK_RESIDENCY_LIFECYCLE_MONGO_URI)
    || env.LK_RESIDENCY_LIFECYCLE_CUP_API_URL !== 'https://padlhub.su/api'
    || !/^\S{32,}$/.test(env.LK_RESIDENCY_LIFECYCLE_CUP_INTEGRATION_TOKEN)
    || env.LK_RESIDENCY_LIFECYCLE_ALLOW_ORIGIN !== 'https://padlhub.ru'
    || env.LK_RESIDENCY_LIFECYCLE_PILOT_CONTROL_FILE !== '/etc/phab-traffic/lk-residency-preview-487/mode') {
    refuse('PILOT_ENV_CONTRACT_INVALID');
  }
  let actors;
  try { actors = JSON.parse(env.LK_RESIDENCY_LIFECYCLE_PILOT_USERS); } catch { refuse('PILOT_ENV_CONTRACT_INVALID'); }
  if (!Array.isArray(actors) || actors.length !== 1 || typeof actors[0] !== 'string'
    || !/^iSkq6G:[a-zA-Z0-9_.@-]{1,256}$/.test(actors[0])) refuse('PILOT_ENV_CONTRACT_INVALID');
}

function select() {
  const raw = readProtected(path.join(directory, 'profiles.json'), { privateFile: true, limit: 4096 });
  const profiles = JSON.parse(raw.toString('utf8'));
  const hasCupStaffLeave = profiles?.schema === 9;
  const hasGenderRetry = hasCupStaffLeave || profiles?.schema === 8;
  const hasPilotRa497 = hasGenderRetry || profiles?.schema === 7;
  const hasPilotKidsBooking = hasPilotRa497 || profiles?.schema === 6;
  const hasPilotQuote = hasPilotKidsBooking || profiles?.schema === 5;
  const hasPilotSuccessor = hasPilotQuote || profiles?.schema === 4;
  const hasPilot = hasPilotSuccessor || profiles?.schema === 3;
  const keys = ['candidateSha256', 'retainedEnvSha256', 'schema', 'sourceSha256'];
  if (hasPilot) keys.push('pilotEnvSha256', 'pilotSha256');
  if (hasPilotSuccessor) keys.push('pilotSuccessorSha256');
  if (hasPilotQuote) keys.push('pilotQuoteSha256');
  if (hasPilotKidsBooking) keys.push('pilotKidsBookingSha256');
  if (hasPilotRa497) keys.push('pilotRa497Sha256');
  if (hasGenderRetry) keys.push('genderRetrySha256');
  if (hasCupStaffLeave) keys.push('cupStaffLeaveSha256');
  if (!profiles || Object.keys(profiles).sort().join(',') !== keys.sort().join(',')
    || (!hasPilot && profiles.schema !== 2) || !shaPattern.test(profiles.sourceSha256)
    || !shaPattern.test(profiles.candidateSha256) || profiles.sourceSha256 === profiles.candidateSha256
    || !Array.isArray(profiles.retainedEnvSha256) || profiles.retainedEnvSha256.length !== retainedEnvFiles.length
    || !profiles.retainedEnvSha256.every((value) => typeof value === 'string' && shaPattern.test(value))) {
    refuse('PROFILES_INVALID');
  }
  if (hasPilot && (typeof profiles.pilotSha256 !== 'string' || typeof profiles.pilotEnvSha256 !== 'string'
    || !shaPattern.test(profiles.pilotSha256) || !shaPattern.test(profiles.pilotEnvSha256)
    || [profiles.sourceSha256, profiles.candidateSha256].includes(profiles.pilotSha256))) {
    refuse('PROFILES_INVALID');
  }
  if (hasPilotSuccessor && (typeof profiles.pilotSuccessorSha256 !== 'string'
    || !shaPattern.test(profiles.pilotSuccessorSha256)
    || [profiles.sourceSha256, profiles.candidateSha256, profiles.pilotSha256].includes(profiles.pilotSuccessorSha256))) {
    refuse('PROFILES_INVALID');
  }
  if (hasPilotQuote && (typeof profiles.pilotQuoteSha256 !== 'string'
    || !shaPattern.test(profiles.pilotQuoteSha256)
    || [profiles.sourceSha256, profiles.candidateSha256, profiles.pilotSha256, profiles.pilotSuccessorSha256]
      .includes(profiles.pilotQuoteSha256))) {
    refuse('PROFILES_INVALID');
  }
  if (hasPilotKidsBooking && (typeof profiles.pilotKidsBookingSha256 !== 'string'
    || !shaPattern.test(profiles.pilotKidsBookingSha256)
    || [profiles.sourceSha256, profiles.candidateSha256, profiles.pilotSha256,
      profiles.pilotSuccessorSha256, profiles.pilotQuoteSha256].includes(profiles.pilotKidsBookingSha256))) {
    refuse('PROFILES_INVALID');
  }
  if (hasPilotRa497 && (profiles.pilotRa497Sha256 !== ra497Sha256
    || [profiles.sourceSha256, profiles.candidateSha256, profiles.pilotSha256, profiles.pilotSuccessorSha256,
      profiles.pilotQuoteSha256, profiles.pilotKidsBookingSha256].includes(profiles.pilotRa497Sha256))) {
    refuse('PROFILES_INVALID');
  }
  if (hasGenderRetry && (profiles.genderRetrySha256 !== genderRetrySha256
    || [profiles.sourceSha256, profiles.candidateSha256, profiles.pilotSha256, profiles.pilotSuccessorSha256,
      profiles.pilotQuoteSha256, profiles.pilotKidsBookingSha256, profiles.pilotRa497Sha256]
      .includes(profiles.genderRetrySha256))) {
    refuse('PROFILES_INVALID');
  }
  if (hasCupStaffLeave && (profiles.cupStaffLeaveSha256 !== cupStaffLeaveSha256
    || [profiles.sourceSha256, profiles.candidateSha256, profiles.pilotSha256, profiles.pilotSuccessorSha256,
      profiles.pilotQuoteSha256, profiles.pilotKidsBookingSha256, profiles.pilotRa497Sha256, profiles.genderRetrySha256]
      .includes(profiles.cupStaffLeaveSha256))) {
    refuse('PROFILES_INVALID');
  }
  for (const [index, filename] of retainedEnvFiles.entries()) {
    const env = readProtected(filename, { privateFile: true, privateDirectory: false, limit: 1024 * 1024 });
    if (sha256(env) !== profiles.retainedEnvSha256[index]) refuse('RETAINED_ENV_HASH_MISMATCH');
    const dotenv = parseEnv(env.toString('utf8'));
    if (Object.keys(dotenv).some((key) => key === 'NODE_OPTIONS' || key === 'CUP_API_BASE_URL'
      || key.startsWith('TOURNAMENT_OWNER_'))) refuse('RETAINED_ENV_PROFILE_OVERLAP');
  }
  const bytes = readProtected(graph, { privateFile: false, limit: 64 * 1024 * 1024 });
  const digest = sha256(bytes);
  if (digest === profiles.sourceSha256) return 'source';
  if (digest === profiles.candidateSha256) return 'candidate';
  if (hasPilot && (digest === profiles.pilotSha256
    || (hasPilotSuccessor && digest === profiles.pilotSuccessorSha256)
    || (hasPilotQuote && digest === profiles.pilotQuoteSha256)
    || (hasPilotKidsBooking && digest === profiles.pilotKidsBookingSha256)
    || (hasPilotRa497 && digest === profiles.pilotRa497Sha256)
    || (hasGenderRetry && digest === profiles.genderRetrySha256)
    || (hasCupStaffLeave && digest === profiles.cupStaffLeaveSha256))) {
    verifyPilotEnv(profiles.pilotEnvSha256);
    return 'pilot';
  }
  refuse('UNREVIEWED_GRAPH_SHA');
}

try {
  if (process.getuid?.() !== 0 || process.argv.length !== 3) refuse('INVOCATION_INVALID');
  const profile = select();
  if (process.argv[2] === 'select') {
    process.stdout.write(profile);
  } else if ((process.argv[2] === 'read-candidate-token' && profile === 'candidate')
    || (process.argv[2] === 'read-pilot-token' && profile === 'pilot')) {
    const raw = readProtected(credential, { privateFile: true, limit: 4097 });
    const token = raw.toString('utf8').replace(/\n$/, '');
    raw.fill(0);
    if (!token.length || token.length > 4096 || /[^\x21-\x7e]/.test(token)) refuse('TOKEN_FORMAT_INVALID');
    process.stdout.write(token);
  } else refuse('INVOCATION_INVALID');
} catch (error) {
  const message = /^[A-Z_]{3,48}$/.test(error?.message || '') ? error.message : 'INPUT_UNAVAILABLE';
  process.stderr.write('LK147 launcher refused startup: ' + message + '\n');
  process.exitCode = 78;
}
