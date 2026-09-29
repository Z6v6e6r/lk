import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const validCursor = value => value === null
  || (typeof value === 'string' && value.startsWith('lk1-product:') && value.length <= 2048);

export async function openLk1UnpaidScanCursor({ file, tenantKey, cohortFrom }) {
  if (!path.isAbsolute(file) || !tenantKey || !cohortFrom) throw new Error('SCAN_CURSOR_CONFIG_INVALID');
  const dir = path.dirname(file), dirStat = await fs.lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0
    || dirStat.uid !== process.getuid() || await fs.realpath(dir) !== dir) {
    throw new Error('SCAN_CURSOR_DIRECTORY_UNSAFE');
  }
  const blank = () => ({ schema: 1, tenantKey, cohortFrom, intentAfterId: null, unclaimedAfterId: null });
  let state = blank();
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || stat.uid !== process.getuid()) throw new Error('SCAN_CURSOR_FILE_UNSAFE');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved?.schema !== 1 || typeof saved.tenantKey !== 'string'
      || typeof saved.cohortFrom !== 'string' || !validCursor(saved.intentAfterId)
      || !validCursor(saved.unclaimedAfterId)) throw new Error('SCAN_CURSOR_FILE_INVALID');
    if (saved.tenantKey !== tenantKey || saved.cohortFrom !== cohortFrom) {
      throw new Error('SCAN_CURSOR_COHORT_DRIFT');
    }
    state = saved;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    afterId(phase) { return state[phase === 'INTENT' ? 'intentAfterId' : 'unclaimedAfterId']; },
    async advance(phase, afterId) {
      if (!['INTENT', 'UNCLAIMED'].includes(phase) || !validCursor(afterId)) {
        throw new Error('SCAN_CURSOR_ADVANCE_INVALID');
      }
      const next = { ...state, [phase === 'INTENT' ? 'intentAfterId' : 'unclaimedAfterId']: afterId };
      const temp = path.join(dir, `.lk1-unpaid-cursor-${crypto.randomBytes(8).toString('hex')}.tmp`);
      let handle;
      try {
        handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(`${JSON.stringify(next)}\n`);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temp, file);
        const dirHandle = await fs.open(dir, constants.O_RDONLY);
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      } catch (error) {
        await handle?.close().catch(() => {});
        await fs.unlink(temp).catch(() => {});
        throw error;
      }
      state = next;
    },
  };
}

export async function scanLk1UnpaidPage({ phase, limit, cursor, loadRows, visit, shouldStop }) {
  if (shouldStop()) return 0;
  const rows = await loadRows(cursor.afterId(phase), limit);
  if (shouldStop()) return 0;
  async function checkpoint(afterId) {
    try { await cursor.advance(phase, afterId); }
    catch { const error = new Error('SCAN_CURSOR_WRITE_FAILED'); error.code = error.message; throw error; }
  }
  for (const row of rows) {
    if (shouldStop()) break;
    await visit(row);
    if (shouldStop()) break;
    await checkpoint(row._id);
  }
  if (!shouldStop() && rows.length < limit) await checkpoint(null);
  return rows.length;
}
