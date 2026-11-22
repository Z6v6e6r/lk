import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function hostedPreviewConfig(env: Record<string, string | undefined>) {
  const base = env.BOOKING_PREVIEW_BASE || '/';
  const source = env.BOOKING_PREVIEW_SOURCE_SHA;
  if (base === '/') return { base, source: null };
  if (!/^\/lk\/booking-preview\/[a-z0-9-]+\/$/.test(base)) throw new Error('Preview must use an isolated versioned path');
  if (!source || !/^[a-f0-9]{40}$/.test(source)) throw new Error('Hosted preview requires a full source commit SHA');
  return { base, source };
}

export async function writeHostedPreview(output: string, config: ReturnType<typeof hostedPreviewConfig>) {
  if (!config.source) return;
  await copyFile(join(output, 'dev/booking-preview/index.html'), join(output, 'index.html'));
  const hashes: Record<string, string> = {};
  async function visit(directory: string, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Preview output must not contain symlinks');
      if (entry.isDirectory()) await visit(join(directory, entry.name), path + '/');
      else if (path !== 'preview-release.json') hashes[path] = createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex');
    }
  }
  await visit(output);
  await writeFile(join(output, 'preview-release.json'), JSON.stringify({ source: config.source, base: config.base,
    mockOnly: true, stages: ['current', 'full'], files: hashes }, null, 2) + '\n');
}
