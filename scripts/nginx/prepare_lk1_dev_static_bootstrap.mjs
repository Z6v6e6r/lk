// Offline reserve-only nginx delta. Actual bootstrap/reload is separately gated.
import { nginxBlocks, sha256 } from './prepare_frontend_static_bootstrap.mjs';
import { devFiles, devInventory, DEV_CURRENT_ROOT, DEV_RELEASES_ROOT } from '../lk1-dev-frontend-release.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BEGIN = '    # BEGIN LK1 reserve DEV static v1';
const END = '    # END LK1 reserve DEV static v1';
export const DEV_NGINX_PATH = '/etc/nginx/sites-available/lk-reserve.tsup.space';
const servers = new Set(['lk-reserve.tsup.space', 'lk-reserve.89-108-64-209.sslip.io']);

export function devStaticFragment() {
  return `${BEGIN}\n` + devFiles.map(name => {
    const manifest = name === 'release-dev.json';
    return `    location = /lk/${name} {
        alias ${DEV_CURRENT_ROOT}/${name};
        default_type ${manifest ? 'application/json' : 'application/javascript'};
        open_file_cache off;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Origin, Content-Type, Accept, Authorization, Range" always;
        add_header Cache-Control "${manifest ? 'no-store, no-cache, must-revalidate, max-age=0' : 'public, max-age=31536000, immutable'}" always;
        if ($request_method = OPTIONS) { return 204; }
        limit_except GET HEAD OPTIONS { deny all; }
    }`;
  }).join('\n\n') + `\n${END}\n`;
}

export function buildDevStaticCandidate(source, expectedSourceSha) {
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha) || sha256(source) !== expectedSourceSha) throw new Error('DEV nginx source SHA mismatch');
  if (source.includes(BEGIN) || source.includes(END) || source.includes(DEV_CURRENT_ROOT)
    || source.includes(DEV_RELEASES_ROOT)) throw new Error('DEV bootstrap already present or unmanaged');
  const blocks = nginxBlocks(source);
  const locations = [...source.matchAll(/^ {4}location = \/lk\/release-dev\.json \{/gm)];
  if (locations.length !== 2) throw new Error('Exactly two reserve DEV manifest locations required');
  const seen = new Set();
  const replacements = locations.map(match => {
    const block = blocks.get(match.index + match[0].length - 1);
    const server = block && blocks.get(block.parent);
    if (!server || server.parent !== undefined || !/(?:^|\n)\s*server\s*$/.test(source.slice(0, block.parent))) {
      throw new Error('DEV manifest must belong directly to top-level server');
    }
    // server_name/root evidence must be outside all nested locations/if blocks.
    let header = source.slice(block.parent + 1, server.end - 1);
    const children = [...blocks.entries()].filter(([, b]) => b.parent === block.parent).sort((a, b) => b[0] - a[0]);
    for (const [start, child] of children) header = header.slice(0, start - block.parent - 1) + header.slice(child.end - block.parent - 1);
    const names = [...header.matchAll(/^\s*server_name\s+([^;]+);/gm)];
    if (names.length !== 1 || !servers.has(names[0][1].trim()) || seen.has(names[0][1].trim())
      || !/^\s*root \/var\/www\/html;\s*$/m.test(header)) throw new Error('Unexpected reserve server identity/root');
    seen.add(names[0][1].trim());
    const end = block.end + (source[block.end] === '\n' ? 1 : 0);
    const original = source.slice(match.index, end);
    if (!/^\s*try_files \$uri =404;\s*$/m.test(original)
      || /\b(?:proxy_pass|alias|rewrite|include)\b/.test(original)) throw new Error('DEV manifest preimage is not the reviewed static route');
    return { start: match.index, end, original };
  });
  for (const name of devFiles) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = [...source.matchAll(new RegExp(`^\\s*location\\s*=\\s*(?:"|')?/lk/${escaped}(?:"|')?\\s*\\{`, 'gm'))].length;
    if (count !== (name === 'release-dev.json' ? 2 : 0)) throw new Error('Existing DEV exact route requires reconciliation');
  }
  const fragment = devStaticFragment();
  let candidate = source;
  for (const edit of [...replacements].reverse()) candidate = candidate.slice(0, edit.start) + fragment + candidate.slice(edit.end);
  return { candidate, sourceSha: expectedSourceSha, candidateSha: sha256(candidate), fragment, replacements,
    paths: devFiles.map(name => `/lk/${name}`), configPath: DEV_NGINX_PATH,
    activePath: DEV_CURRENT_ROOT, releasesPath: DEV_RELEASES_ROOT,
    liveMutationAuthorized: false, applied: false };
}

export function prepareDevBootstrap({ sourceNginx, expectedSourceSha, installed, distDir, outDir }) {
  const sourceStat = fs.lstatSync(sourceNginx);
  if (!sourceStat.isFile() || sourceStat.nlink !== 1) throw new Error('DEV nginx preimage must be regular and unaliased');
  const source = fs.readFileSync(sourceNginx, 'utf8');
  const result = buildDevStaticCandidate(source, expectedSourceSha);
  const observed = devInventory(distDir);
  if (JSON.stringify(observed) !== JSON.stringify(installed)) throw new Error('DEV installed inventory differs; never relabel baseline');
  const artifacts = new Map(devFiles.map(name => [name, fs.readFileSync(path.join(distDir, name))]));
  if ([...artifacts].some(([name, bytes]) => sha256(bytes) !== installed.hashes[name])) throw new Error('DEV baseline drifted during read');
  if (!path.isAbsolute(outDir)) throw new Error('Absolute private output required');
  const parent = path.dirname(outDir), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || fs.realpathSync(parent) !== parent || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw new Error('Canonical private user-owned parent required');
  }
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: parent, stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error('DEV private bootstrap must remain outside every Git workspace');
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  const digest = sha256(JSON.stringify(devFiles.map(name => [name, installed.hashes[name]])));
  const plan = { schema: 'LK1_RESERVE_DEV_BOOTSTRAP_V1', installed,
    host: 'lk-reserve-89', configPath: DEV_NGINX_PATH,
    sourceSha: result.sourceSha, candidateSha: result.candidateSha,
    activePath: DEV_CURRENT_ROOT, retainedReleasePath: `${DEV_RELEASES_ROOT}/${installed.source}-${digest.slice(0, 16)}`,
    routedPaths: result.paths, legacyDirectoryMutationAllowed: false, liveMutationAuthorized: false, applied: false,
    gates: ['Sole owner verifies exact nginx, twelve DEV baseline hashes, and unchanged prod/API/font baseline',
      'Copy and fsync retained twelve-file baseline, verify hashes, create isolated current pointer; never alter legacy lk',
      'Back up exact nginx bytes, test candidate in isolation, guarded install, nginx -t, then reload',
      'Verify twelve public hashes and cache/CORS on both servers plus unchanged prod/API/fonts and DEV browser smoke',
      'Failure: restore nginx only over exact candidate hash, nginx -t and reload; verify original public baseline; retain isolated artifacts'],
    rollback: { sourceFile: 'nginx.source.conf', expectedLiveSha: result.candidateSha, restoredSha: result.sourceSha,
      foreignDriftAction: 'STOP; retain artifacts; never overwrite unknown nginx or pointers' } };
  fs.mkdirSync(outDir, { mode: 0o700 });
  fs.mkdirSync(path.join(outDir, 'release'), { mode: 0o755 });
  for (const [name, bytes] of artifacts) fs.writeFileSync(path.join(outDir, 'release', name), bytes, { flag: 'wx', mode: 0o644 });
  fs.writeFileSync(path.join(outDir, 'nginx.source.conf'), source, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'nginx.candidate.conf'), result.candidate, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'bootstrap.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 5) throw new Error('Usage: <nginx-source> <source-sha> <installed-inventory.json> <baseline-dist> <new-private-output>');
  const plan = prepareDevBootstrap({ sourceNginx: args[0], expectedSourceSha: args[1],
    installed: JSON.parse(fs.readFileSync(args[2], 'utf8')), distDir: args[3], outDir: args[4] });
  console.log(JSON.stringify({ sourceSha: plan.sourceSha, candidateSha: plan.candidateSha,
    routedPaths: plan.routedPaths, liveMutationAuthorized: false }));
}
