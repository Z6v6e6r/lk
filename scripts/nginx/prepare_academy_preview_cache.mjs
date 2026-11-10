// Offline only: preserve the live vhost and add cache guards for two public files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nginxBlocks } from './prepare_frontend_static_bootstrap.mjs';

export const ACADEMY_PREVIEW_HOST = 'lk-reserve.89-108-64-209.sslip.io';
export const ACADEMY_MUTABLE_PATHS = ['/lk/academy-preview/index.html', '/lk/academy-preview/release-ffc-academy-dev.json'];
const marker = '# BEGIN academy preview cache v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function prepareAcademyPreviewCache(source, expectedSha) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha) || sha(source) !== expectedSha) throw new Error('Nginx source SHA mismatch');
  if (source.includes(marker)) throw new Error('Academy cache guards already present');
  const blocks = nginxBlocks(source);
  const enclosing = index => [...blocks].filter(([start, block]) => start < index && index < block.end).sort((a, b) => b[0] - a[0])[0];
  const targets = [];
  for (const match of source.matchAll(/^[ \t]*server_name\s+([^;]+);/gm)) {
    if (!match[1].split(/\s+/).includes(ACADEMY_PREVIEW_HOST)) continue;
    const entry = enclosing(match.index);
    if (!entry) throw new Error('Unscoped academy server name');
    const [start, block] = entry;
    if (source.slice(source.lastIndexOf('\n', start) + 1, start).trim() !== 'server') throw new Error('Academy name must belong to a server');
    const body = source.slice(start + 1, block.end - 1);
    const tls = [...body.matchAll(/^[ \t]*listen\s+(?:[[\]:0-9.]+:)?443(?:\s|;)/gm)]
      .some(listen => enclosing(start + 1 + listen.index)?.[0] === start);
    if (tls && !targets.some(target => target.start === start)) targets.push({ start, end: block.end });
  }
  if (targets.length !== 1) throw new Error('Expected exactly one academy HTTPS server');
  const target = targets[0], body = source.slice(target.start, target.end);
  if (body.includes('/lk/academy-preview/')) throw new Error('Existing academy routes require explicit reconciliation');
  const fragment = `    ${marker}\n` + ACADEMY_MUTABLE_PATHS.map(uri =>
    `    location = ${uri} {\n        root /var/www/html;\n        try_files $uri =404;\n        open_file_cache off;\n        add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;\n    }\n`).join('\n') + '    # END academy preview cache v1\n';
  const candidate = source.slice(0, target.end - 1) + '\n' + fragment + source.slice(target.end - 1);
  return { candidate, sourceSha256: expectedSha, candidateSha256: sha(candidate), paths: ACADEMY_MUTABLE_PATHS };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, expectedSha, output] = process.argv.slice(2);
  if (!input || !output || !expectedSha || path.resolve(input) === path.resolve(output)) throw new Error('Usage: prepare_academy_preview_cache.mjs <source> <expected-sha> <new-output>');
  const result = prepareAcademyPreviewCache(fs.readFileSync(input, 'utf8'), expectedSha);
  fs.writeFileSync(output, result.candidate, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: result.sourceSha256, candidateSha256: result.candidateSha256, paths: result.paths, liveMutation: false }));
}
