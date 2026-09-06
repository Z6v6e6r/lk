// Offline candidate builder. No SSH, nginx reload, host install or live apply command.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { files } from '../frontend-release.mjs';

export const CURRENT_ROOT = '/var/www/html/lk-frontend-current';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const STATIC_MARKER = '    location ^~ /lk/ {\n        alias /var/www/html/lk/;';
const BEGIN = '    # BEGIN LK isolated frontend static v1';
const END = '    # END LK isolated frontend static v1';
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lex braces outside quoted strings/comments; record actual nesting, never indentation.
function nginxBlocks(source) {
  const blocks = new Map(), stack = [];
  let quote = null, comment = false, inToken = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (comment) { if (char === '\n') comment = false; continue; }
    if (char === '\\') { inToken = true; i++; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (!inToken && (char === '"' || char === "'")) { quote = char; inToken = true; continue; }
    if (char === '#' && !inToken) { comment = true; continue; }
    if (/\s/.test(char) || char === ';') { inToken = false; continue; }
    if (inToken) continue;
    if (char === '{') { blocks.set(i, { parent: stack.at(-1), end: null }); stack.push(i); }
    if (char === '}') {
      if (!stack.length) throw new Error('Unbalanced nginx block');
      blocks.get(stack.pop()).end = i + 1;
    }
    if (char !== '{' && char !== '}') inToken = true;
  }
  if (stack.length || quote) throw new Error('Unterminated nginx block or string');
  return blocks;
}

export function frontendStaticFragment() {
  const locations = files.map(name => {
    const cache = name === 'release.json' ? 'no-store, no-cache, must-revalidate, max-age=0' : 'public, max-age=31536000, immutable';
    const type = name.endsWith('.js') ? 'application/javascript' : name.endsWith('.json') ? 'application/json' : 'font/woff2';
    return `    location = /lk/${name} {\n        alias ${CURRENT_ROOT}/${name};\n        default_type ${type};\n        open_file_cache off;\n        add_header Access-Control-Allow-Origin "*" always;\n        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;\n        add_header Access-Control-Allow-Headers "Origin, Content-Type, Accept, Authorization, Range" always;\n        add_header Cache-Control "${cache}" always;\n        if ($request_method = OPTIONS) { return 204; }\n        limit_except GET HEAD OPTIONS { deny all; }\n    }`;
  });
  return `${BEGIN}\n${locations.join('\n\n')}\n${END}\n`;
}

export function buildFrontendStaticCandidate(source, expectedSourceSha) {
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha) || sha256(source) !== expectedSourceSha) throw new Error('Nginx source SHA mismatch');
  if (source.includes(BEGIN) || source.includes(END) || source.includes(CURRENT_ROOT)) throw new Error('Isolation already present or unmanaged current-release route');
  const marker = source.indexOf(STATIC_MARKER);
  if (marker < 0 || source.indexOf(STATIC_MARKER, marker + 1) >= 0) throw new Error('Expected one existing legacy static /lk/ location');
  // Preserve all bytes outside the manifest block, including inline-closing layouts.
  const matches = [...source.matchAll(/^ {4}location = \/lk\/release\.json \{/gm)];
  if (matches.length !== 1) throw new Error('Expected one existing exact release.json location');
  const release = matches[0];
  const blocks = nginxBlocks(source);
  const block = blocks.get(release.index + release[0].length - 1);
  const legacy = blocks.get(marker + STATIC_MARKER.indexOf('{'));
  if (!block || !legacy || release.index >= marker || block.parent === undefined || block.parent !== legacy.parent) throw new Error('Manifest and legacy static location must belong to the same server');
  const end = block.end + (source[block.end] === '\n' ? 1 : 0);
  const original = source.slice(release.index, end);
  if (!original.includes('        root /var/www/html;\n') || !original.includes('        try_files $uri =404;\n')) throw new Error('Unrecognized manifest source location');
  for (const name of files) {
    const pattern = new RegExp(`^\\s*location\\s*=\\s*(?:"|')?/lk/${escapeRegex(name)}(?:"|')?\\s*\\{`, 'gm');
    const count = [...source.matchAll(pattern)].length;
    if (count !== (name === 'release.json' ? 1 : 0)) throw new Error(`Existing exact route requires separate reconciliation: /lk/${name}`);
  }
  const fragment = frontendStaticFragment();
  const candidate = source.slice(0, release.index) + fragment + source.slice(end);
  return { candidate, sourceSha: expectedSourceSha, candidateSha: sha256(candidate), fragment, paths: files.map(name => `/lk/${name}`) };
}

function regularBytes(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Artifact must be a regular unaliased file');
  return fs.readFileSync(file);
}

export function prepareBootstrap({ sourceNginx, expectedSourceSha, installed, distDir, fontsDir, outDir }) {
  if (!installed || !/^[a-f0-9]{40}$/.test(installed.source ?? '') || !/^[A-Za-z0-9._-]{1,100}$/.test(installed.version ?? '')) throw new Error('Exact installed source/version required');
  if (JSON.stringify(Object.keys(installed.hashes ?? {}).sort()) !== JSON.stringify([...files].sort())) throw new Error('Exact 16-file installed hash inventory required');
  const nginx = regularBytes(sourceNginx).toString('utf8');
  const result = buildFrontendStaticCandidate(nginx, expectedSourceSha);
  for (const directory of [distDir, fontsDir]) if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Artifact directories must not be symlinks');
  const artifacts = new Map(files.map(name => {
    const bytes = regularBytes(name.startsWith('fonts/') ? path.join(fontsDir, path.basename(name)) : path.join(distDir, name));
    if (sha256(bytes) !== installed.hashes[name]) throw new Error(`Installed artifact hash mismatch: ${name}`);
    return [name, bytes];
  }));
  const manifest = JSON.parse(artifacts.get('release.json').toString('utf8'));
  if (manifest.sourceCommit !== installed.source || manifest.sourceDirty !== false || manifest.version !== installed.version) throw new Error('Installed manifest provenance mismatch; never relabel an old build');
  const parent = path.dirname(path.resolve(outDir));
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 || parentStat.uid !== process.getuid()) throw new Error('Output requires an existing user-owned private parent (0700)');
  const canonicalOut = path.join(fs.realpathSync(parent), path.basename(outDir));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const relative = path.relative(repo, canonicalOut);
  if (!relative.startsWith('..' + path.sep) && relative !== '..') throw new Error('Private bootstrap output must remain outside the repository');
  fs.mkdirSync(canonicalOut, { mode: 0o700 }); // exclusive: an existing/partial candidate is never overwritten
  fs.mkdirSync(path.join(canonicalOut, 'release'), { mode: 0o755 });
  fs.mkdirSync(path.join(canonicalOut, 'release/fonts'), { mode: 0o755 });
  for (const [name, bytes] of artifacts) fs.writeFileSync(path.join(canonicalOut, 'release', name), bytes, { flag: 'wx', mode: 0o644 });
  fs.writeFileSync(path.join(canonicalOut, 'nginx.source.conf'), nginx, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(canonicalOut, 'nginx.candidate.conf'), result.candidate, { flag: 'wx', mode: 0o600 });
  const releaseDigest = sha256(JSON.stringify(files.map(name => [name, installed.hashes[name]])));
  const plan = { schema: 'LK_FRONTEND_STATIC_BOOTSTRAP_V1', installed,
    nginx: { sourceSha: result.sourceSha, candidateSha: result.candidateSha },
    activePath: CURRENT_ROOT, retainedReleasePath: `/var/www/html/lk-frontend-releases/${installed.source}-${releaseDigest.slice(0, 16)}`,
    legacyPath: '/var/www/html/lk', legacyDirectoryMutationAllowed: false, routedPaths: result.paths,
    liveMutationAuthorized: false, applied: false,
    gates: ['Verify current nginx and all installed artifact preimages under one approved writer boundary',
      'Install the exact retained baseline and new current symlink without modifying legacy lk',
      'Test candidate nginx configuration in isolation, then guarded install and nginx -t before reload',
      'Read back all 16 public hashes, cache/CORS and preserved legacy URL baselines, then browser smoke',
      'On failure restore exact nginx preimage and reload; keep the baseline files and current symlink for investigation'],
    rollback: { sourceFile: 'nginx.source.conf', expectedLiveSha: result.candidateSha, restoredSha: result.sourceSha,
      rule: 'Refuse rollback over unknown nginx bytes; do not remove the legacy directory or retained artifacts' },
  };
  fs.writeFileSync(path.join(canonicalOut, 'bootstrap.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return plan;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 6) throw new Error('Usage: prepare_frontend_static_bootstrap.mjs <nginx-source> <source-sha256> <installed-json> <dist> <fonts> <new-private-out>');
  const plan = prepareBootstrap({ sourceNginx: args[0], expectedSourceSha: args[1], installed: JSON.parse(fs.readFileSync(args[2], 'utf8')), distDir: args[3], fontsDir: args[4], outDir: args[5] });
  console.log(JSON.stringify({ source: plan.installed.source, sourceSha: plan.nginx.sourceSha, candidateSha: plan.nginx.candidateSha, routedPaths: plan.routedPaths, liveMutationAuthorized: false }, null, 2));
}
