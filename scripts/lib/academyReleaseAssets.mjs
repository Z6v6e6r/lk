import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A version identifies immutable bytes, including during rollback and old-tab reloads.
export function materializeImmutableAcademyBundle(outDir, version) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(version)) {
    throw new Error('Invalid academy release version');
  }
  const relative = `releases/${version}/ffc-academy-lk-dev.js`;
  const source = fs.readFileSync(path.join(outDir, 'ffc-academy-lk-dev.js'));
  const destination = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.writeFileSync(destination, source, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.readFileSync(destination).equals(source)) {
      throw new Error('Immutable academy release already exists with different bytes');
    }
  }
  return { path: relative, sha256: crypto.createHash('sha256').update(source).digest('hex') };
}
