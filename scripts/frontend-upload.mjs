// Transport adapter for deploy-lk.sh's standard frontend path; no remote shell/SFTP.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { files, remoteRequest } from './frontend-release.mjs';

export function uploadStaticFiles({ destination, token, distDir, fontsDir, remote = remoteRequest }) {
  if (!/^\/var\/www\/html\/lk-frontend-releases\/[a-f0-9]{40}-[a-f0-9]{16}$/.test(destination ?? '')) throw new Error('Exact staged static destination required');
  if (!distDir || !fontsDir) throw new Error('Validated deploy inventory directories required');
  if (!/^[a-f0-9]{32}$/.test(token ?? '')) throw new Error('Static upload lease token required');
  for (const name of files) {
    const bytes = readFileSync(name.startsWith('fonts/') ? join(fontsDir, name.slice(6)) : join(distDir, name));
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error(`Invalid artifact size: ${name}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = remote({ op: 'upload', token, candidate: destination.split('/').at(-1), name,
      size: bytes.length, sha256, data: bytes.toString('base64') });
    if (result.uploaded !== name || result.sha256 !== sha256) throw new Error(`Upload receipt mismatch: ${name}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  uploadStaticFiles({ destination: process.argv[2], distDir: process.argv[3], fontsDir: process.argv[4], token: process.env.DEPLOY_FRONTEND_LEASE_TOKEN });
}
