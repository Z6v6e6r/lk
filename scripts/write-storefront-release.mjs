import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';

export async function writeStorefrontRelease(outDir, channel, { cwd = process.cwd(), now = new Date(), version } = {}) {
  if (channel !== 'prod' && channel !== 'dev') throw new Error('Storefront channel must be prod or dev');
  const suffix = channel === 'dev' ? '-dev' : '';
  const fileName = `subscription-storefront${suffix}.js`;
  const targetDir = resolve(cwd, outDir);
  const bundle = await readFile(resolve(targetDir, fileName));
  // Reject stale or mismatched artifacts before claiming isolation in a manifest.
  const contract = bundle.toString('utf8').match(/window\.LKWidgetSubscriptionStorefront\s*=\s*\{([^}]+)/)?.[1] || '';
  if (!/\bcheckoutVersion\s*:\s*1\b/.test(contract) || !/\bcheckoutIsolationVersion\s*:\s*1\b/.test(contract)
      || !new RegExp(`\\bcheckoutChannel\\s*:\\s*["']${channel}["']`).test(contract)) {
    throw new Error('Bundle is missing the isolated checkout contract or has a different channel');
  }
  let provenance;
  try { provenance = readRepositoryProvenance(cwd); }
  catch (error) {
    console.warn(`Git provenance is unavailable: ${error.message}`);
    provenance = { sourceCommit: null, sourceBranch: null, sourceDirty: true };
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const payload = {
    version: version?.trim() || (process.env.LK_RELEASE_VERSION || '').trim() || stamp,
    generatedAt: now.toISOString(),
    sourceCommit: provenance.sourceCommit, sourceBranch: provenance.sourceBranch, sourceDirty: provenance.sourceDirty,
    checkoutVersion: 1, checkoutIsolationVersion: 1, checkoutChannel: channel,
    script: { fileName, integrity: `sha384-${createHash('sha384').update(bundle).digest('base64')}` },
  };
  const targetFile = resolve(targetDir, `release${suffix}.json`);
  await writeFile(targetFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { targetFile, payload };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/write-storefront-release.mjs <outDir> <prod|dev>');
  const { targetFile } = await writeStorefrontRelease(process.argv[2], process.argv[3]);
  console.log(`Storefront release manifest written to ${targetFile}`);
}
