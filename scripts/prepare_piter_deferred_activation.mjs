#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPiterDeferredAttestation, buildPiterDeferredActivationPacket,
  redactPiterDeferredActivationPacket } from './lib/piterDeferredActivationContract.mjs';

export function readPrivateDeferredJson(file, expectedUid = process.getuid()) {
  if (!path.isAbsolute(file)) throw new Error('absolute private input required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== expectedUid || (st.mode & 0o077) !== 0) throw new Error('private input custody');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

export function prepareDeferredActivation({ inputFile, outputDir }) {
  if (!path.isAbsolute(outputDir) || fs.existsSync(outputDir)) throw new Error('new absolute output directory required');
  const input = readPrivateDeferredJson(inputFile);
  if (Object.keys(input).sort().join(',') !== ['ledgerEvidence','providerEvidence','subscriptionEvidence','productEvidence','bindingEvidence','attemptEvidence','publication'].sort().join(',')) throw new Error('input scope');
  const createdAt = new Date().toISOString();
  const { ledgerEvidence, providerEvidence, subscriptionEvidence, ...rest } = input;
  const attestation = buildPiterDeferredAttestation({ ledgerEvidence, providerEvidence, subscriptionEvidence, createdAt });
  const packet = buildPiterDeferredActivationPacket({ ...rest, attestation, createdAt });
  fs.mkdirSync(outputDir, { mode:0o700 });
  for (const [name, value] of [['activation.packet.json',packet],['report.json',redactPiterDeferredActivationPacket(packet)]]) {
    const fd = fs.openSync(path.join(outputDir,name), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const fd = fs.openSync(outputDir,'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return redactPiterDeferredActivationPacket(packet);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output-dir') throw new Error('usage');
    console.log(JSON.stringify(prepareDeferredActivation({ inputFile:args[1], outputDir:args[3] })));
  } catch { console.error('Deferred packet preparation blocked; no live operation performed.'); process.exitCode=1; }
}
