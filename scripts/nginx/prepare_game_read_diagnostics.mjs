import crypto from 'node:crypto';
import fs from 'node:fs';
import { scanNginxInventoryStructure } from '../partner_game_membership_nginx_lexical.mjs';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const HTTP_FRAGMENT = fs.readFileSync(new URL('./lk-game-read-diagnostics-http.conf', import.meta.url), 'utf8');
const names = ['X-LK-Client-Request-ID', 'X-LK-Client-Build'];
const marker = '# lk-game-read-diagnostics-v1';
const directives = `${marker}
    access_log /var/log/nginx/lk-game-read-diagnostics.jsonl lk_game_read_diagnostics if=$lk_game_read_loggable;
    proxy_set_header X-LK-Client-Request-ID "";
    proxy_set_header X-LK-Client-Build "";
`;

// Pure candidate builder, no apply/reload path. Input/output are private config artifacts.
// The existing lexical scanner rejects unsupported/malformed structure before any edit.
export function prepareGameReadDiagnostics(source, expectedSha256) {
  if (sha256(source) !== expectedSha256) throw Error('NGINX_SOURCE_HASH_MISMATCH');
  const rows = scanNginxInventoryStructure(source);
  const targets = rows.filter(r => r.block && r.words.map(w => w.value).join(' ') === 'location ^~ /lk/games/');
  if (targets.length !== 1) throw Error('NGINX_GAME_LOCATION_AMBIGUOUS');
  const target = targets[0];
  if (target.context.at(-1) !== 'server') throw Error('NGINX_GAME_LOCATION_CONTEXT');
  const children = rows.filter(r => r.contextIds.at(-1) === target.blockId);
  if (children.some(r => r.block && r.words[0].value === 'location') || children.some(r => r.words[0].value === 'include')) throw Error('NGINX_GAME_LOCATION_UNSUPPORTED');
  const values = name => children.filter(r => !r.block && r.words[0].value === name).map(r => r.words.slice(1).map(w => w.value));
  // Preserve existing log/header inheritance: never introduce the first local override.
  if (!values('access_log').some(v => v.length <= 2 && v[0] === '/var/log/nginx/access.log' && (!v[1] || v[1] === 'combined'))
    || values('access_log').some(v => v[0] === 'off')) throw Error('NGINX_EXPLICIT_CANONICAL_LOG_REQUIRED');
  if (!values('proxy_set_header').some(v => v[0].toLowerCase() === 'host')) throw Error('NGINX_EXPLICIT_PROXY_HEADERS_REQUIRED');
  if (values('proxy_pass').length !== 1) throw Error('NGINX_SINGLE_UPSTREAM_REQUIRED');
  const headers = children.filter(r => !r.block && r.words[0].value === 'add_header' && r.words[1]?.value.toLowerCase() === 'access-control-allow-headers');
  if (headers.length !== 1 || headers[0].words.length !== 4 || headers[0].words[3].value !== 'always') throw Error('NGINX_ALLOW_HEADERS_UNSUPPORTED');
  const header = headers[0];
  const original = header.words[2].value;
  if (!/^[A-Za-z0-9-]+(?:,\s*[A-Za-z0-9-]+)*$/.test(original)) throw Error('NGINX_ALLOW_HEADERS_UNSUPPORTED');
  const prior = original.split(',').map(s => s.trim().toLowerCase());
  if (new Set(prior).size !== prior.length) throw Error('NGINX_ALLOW_HEADERS_DUPLICATE');
  const next = [...original.split(',').map(s => s.trim()), ...names.filter(n => !prior.includes(n.toLowerCase()))].join(', ');
  const instrumentation = rows.filter(r => !r.block && (
    (r.words[0].value === 'access_log' && r.words[1]?.value === '/var/log/nginx/lk-game-read-diagnostics.jsonl')
    || (r.words[0].value === 'proxy_set_header' && names.some(n => n.toLowerCase() === r.words[1]?.value.toLowerCase()))));
  const lines = source.split('\n');
  const locationLine = target.words[0].line - 1;
  const headerLine = header.words[0].line - 1;
  if (!/^\s*location\s+\^~\s+\/lk\/games\/\s*\{\s*$/.test(lines[locationLine])
    || !/^\s*add_header\s+Access-Control-Allow-Headers\s+"[^"\n]+"\s+always;\s*$/i.test(lines[headerLine])) throw Error('NGINX_DIRECTIVE_LAYOUT_UNSUPPORTED');
  if (source.includes(marker)) {
    const markerLine = lines.findIndex(line => line.includes(marker));
    if (source.split(marker).length !== 2 || !source.includes(directives) || original !== next
      || instrumentation.length !== 3 || instrumentation.some(r => r.contextIds.at(-1) !== target.blockId)
      || instrumentation[0].words[0].line - 1 !== markerLine + 1) throw Error('NGINX_DIAGNOSTIC_CONFLICT');
    return { candidate: source, sourceSha256: expectedSha256, candidateSha256: expectedSha256, changed: false };
  }
  if (source.includes('lk_game_read_') || instrumentation.length) throw Error('NGINX_DIAGNOSTIC_CONFLICT');
  lines[headerLine] = lines[headerLine].replace(original, next);
  lines.splice(locationLine + 1, 0, directives.trimEnd());
  const candidate = lines.join('\n');
  scanNginxInventoryStructure(candidate);
  return { candidate, sourceSha256: expectedSha256, candidateSha256: sha256(candidate), changed: true };
}
