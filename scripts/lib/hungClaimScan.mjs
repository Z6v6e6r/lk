import fs from 'node:fs';
import path from 'node:path';

/** Stable keyset traversal for string operation keys. Skipped rows cannot occupy
 * every tick forever; reaching the end starts another complete pass. */
export async function readHungClaimPage({ collection, query, limit, afterId = null }) {
  const read = after => collection.find(after ? { $and: [query, { _id: { $gt: after } }] } : query)
    .sort({ _id: 1 }).limit(limit).toArray();
  let operations = await read(afterId);
  if (!operations.length && afterId !== null) operations = await read(null);
  if (operations.some(row => typeof row._id !== 'string' || !row._id)) throw new Error('SCAN_KEY_UNSUPPORTED');
  return { operations, afterId: operations.at(-1)?._id ?? null };
}

export function readScanCursor(file, scope) {
  if (!file || !fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.version !== 1 || value.scope !== scope) return null;
  if (value.afterId !== null && (typeof value.afterId !== 'string' || !value.afterId)) throw new Error('SCAN_CURSOR_INVALID');
  return value.afterId;
}

export function writeScanCursor(file, scope, afterId) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, scope, afterId }), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
