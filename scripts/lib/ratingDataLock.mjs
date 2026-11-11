import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const RATING_DATA_LOCK = '/var/lock/padlhub-rating-worker.lock';

// flock(1) locks the inherited open-file description. Our descriptor keeps the
// lock alive across awaits and releases it on close or process death.
export async function withRatingDataLock(work, {
  path = process.env.RATING_WORKER_LOCK_FILE || RATING_DATA_LOCK,
  waitSeconds = 120,
  busyError = 'RATING_DATA_LOCK_BUSY',
} = {}) {
  const fd = fs.openSync(path, 'a+');
  try {
    const held = fs.fstatSync(fd), actual = fs.statSync(path);
    if (!held.isFile() || held.ino !== actual.ino || held.dev !== actual.dev) throw Error('RATING_DATA_LOCK_UNAVAILABLE');
    const result = spawnSync('/usr/bin/flock', ['-w', String(waitSeconds), '-E', '75', '9'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', fd],
    });
    if (result.status === 75) throw Error(busyError);
    if (result.status !== 0) throw Error('RATING_DATA_LOCK_UNAVAILABLE');
    return await work(fd);
  } finally {
    fs.closeSync(fd);
  }
}
