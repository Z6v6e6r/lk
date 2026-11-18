import crypto from 'node:crypto';
import fs from 'node:fs';
import { scanNginxInventoryStructure } from '../partner_game_membership_nginx_lexical.mjs';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const HTTP_FRAGMENT = fs.readFileSync(new URL('./lk-game-read-diagnostics-http.conf', import.meta.url), 'utf8');
const names = ['X-LK-Client-Request-ID', 'X-LK-Client-Build'];
const marker = '# lk-game-read-diagnostics-v1';
const reserveRoute = '^/lk/(analytics|advertising|chats|communities|games|media|onboarding|push|support|tournaments)(/|$)';
const words = row => row.words.map(w => w.value);

// Pure, hash-guarded builder. No apply/reload and no routing changes.
export function prepareGameReadDiagnostics(source, expectedSha256, { role = 'primary', httpSource, expectedHttpSha256, includeSources = {} } = {}) {
  if (sha256(source) !== expectedSha256) throw Error('NGINX_SOURCE_HASH_MISMATCH');
  if (!['primary', 'reserve'].includes(role)) throw Error('NGINX_ROLE_UNSUPPORTED');
  const rows = scanNginxInventoryStructure(source), lines = source.split('\n');
  const signature = role === 'primary' ? ['location','^~','/lk/games/'] : ['location','~',reserveRoute];
  const targets = rows.filter(r => r.block && JSON.stringify(words(r)) === JSON.stringify(signature));
  if (targets.length !== 1) throw Error('NGINX_GAME_LOCATION_AMBIGUOUS');
  const target = targets[0];
  if (target.context.at(-1) !== 'server') throw Error('NGINX_GAME_LOCATION_CONTEXT');
  const children = rows.filter(r => r.contextIds.at(-1) === target.blockId);
  if (children.some(r => r.block && r.words[0].value === 'location') || children.some(r => r.words[0].value === 'include')) throw Error('NGINX_GAME_LOCATION_UNSUPPORTED');
  const values = name => children.filter(r => !r.block && r.words[0].value === name).map(r => words(r).slice(1));
  if (!values('proxy_set_header').some(v => v[0].toLowerCase() === 'host')) throw Error('NGINX_EXPLICIT_PROXY_HEADERS_REQUIRED');
  if (values('proxy_pass').length !== 1) throw Error('NGINX_SINGLE_UPSTREAM_REQUIRED');
  const descendants = rows.filter(r => r.contextIds.includes(target.blockId));
  // Reserve has its own if/OPTIONS headers; both must remain consistent.
  const headers = descendants.filter(r => !r.block && r.words[0].value === 'add_header' && r.words[1]?.value.toLowerCase() === 'access-control-allow-headers');
  if (headers.length !== (role === 'primary' ? 1 : 2)) throw Error('NGINX_ALLOW_HEADERS_UNSUPPORTED');
  const replacements = headers.map(header => {
    if (header.words.length !== 4 || header.words[3].value !== 'always') throw Error('NGINX_ALLOW_HEADERS_UNSUPPORTED');
    const original = header.words[2].value;
    if (!/^[A-Za-z0-9-]+(?:,\s*[A-Za-z0-9-]+)*$/.test(original)) throw Error('NGINX_ALLOW_HEADERS_UNSUPPORTED');
    const prior = original.split(',').map(s => s.trim().toLowerCase());
    if (new Set(prior).size !== prior.length) throw Error('NGINX_ALLOW_HEADERS_DUPLICATE');
    const next = [...original.split(',').map(s => s.trim()), ...names.filter(n => !prior.includes(n.toLowerCase()))].join(', ');
    const line = header.words[0].line - 1;
    if (!/^\s*add_header\s+Access-Control-Allow-Headers\s+"[^"\n]+"\s+always;\s*$/i.test(lines[line])) throw Error('NGINX_DIRECTIVE_LAYOUT_UNSUPPORTED');
    return { original, next, line };
  });
  const instrumentation = rows.filter(r => !r.block && ((r.words[0].value === 'access_log' && r.words[1]?.value === '/var/log/nginx/lk-game-read-diagnostics.jsonl')
    || (r.words[0].value === 'proxy_set_header' && names.some(n => n.toLowerCase() === r.words[1]?.value.toLowerCase()))));
  const tail = `    access_log /var/log/nginx/lk-game-read-diagnostics.jsonl lk_game_read_diagnostics if=$lk_game_read_loggable;\n`
    + `    proxy_set_header X-LK-Client-Request-ID ${role === 'primary' ? '""' : '$lk_game_read_forward_id'};\n`
    + `    proxy_set_header X-LK-Client-Build ${role === 'primary' ? '""' : '$lk_game_read_forward_build'};\n`;
  const locationLine = target.words[0].line - 1;
  if (!/^\s*location[^\n]+\{\s*$/.test(lines[locationLine])) throw Error('NGINX_DIRECTIVE_LAYOUT_UNSUPPORTED');
  const canonical = logs => logs.some(r => words(r).slice(1).join(' ') === '/var/log/nginx/access.log' || words(r).slice(1).join(' ') === '/var/log/nginx/access.log combined');
  const localLogs = children.filter(r => !r.block && r.words[0].value === 'access_log');
  const directiveText = (r, fromLines) => {
    const line = r.preimageLine ?? fromLines[r.words[0].line - 1];
    if (!/^\s*access_log\s+[^\n]+;\s*$/.test(line)) throw Error('NGINX_LOG_LAYOUT_UNSUPPORTED');
    if (r.words[1]?.value === 'off') throw Error('NGINX_LOG_DISABLED');
    return '    ' + line.trim();
  };
  // Adding a local access_log disables inherited logs. Materialize the entire closest
  // effective list, including support/conditional logs, never just the canonical file.
  const scopedLogs = (scopeRows, scopeLines, chain = []) => scopeRows.flatMap(r => {
    if (r.words[0].value === 'access_log') return [{ ...r, preimageLine: scopeLines[r.words[0].line - 1] }];
    if (r.words[0].value !== 'include') return [];
    const file = r.words[1]?.value;
    if (r.words.length !== 2 || !file?.startsWith('/') || /[*?$]/.test(file) || chain.includes(file) || chain.length >= 8) throw Error('NGINX_ANCESTOR_INCLUDE_UNSUPPORTED');
    const entry = includeSources[file];
    if (!entry || sha256(entry.text) !== entry.sha256) throw Error('NGINX_ANCESTOR_INCLUDE_UNATTESTED');
    const included = scanNginxInventoryStructure(entry.text).filter(row => !row.block && !row.contextIds.length);
    return scopedLogs(included, entry.text.split('\n'), [...chain, file]);
  });
  let inherited = [], logLines = lines;
  if (!localLogs.length || source.includes(marker)) {
    for (const id of [...target.contextIds].reverse()) {
      inherited = scopedLogs(rows.filter(r => !r.block && r.contextIds.at(-1) === id), lines);
      if (inherited.length) break;
    }
    if (!inherited.length && httpSource !== undefined) {
      if (sha256(httpSource) !== expectedHttpSha256) throw Error('NGINX_HTTP_SOURCE_HASH_MISMATCH');
      const outer = scanNginxInventoryStructure(httpSource);
      const http = outer.filter(r => r.block && words(r).join(' ') === 'http');
      if (http.length !== 1) throw Error('NGINX_HTTP_CONTEXT_AMBIGUOUS');
      inherited = scopedLogs(outer.filter(r => !r.block && r.contextIds.at(-1) === http[0].blockId), httpSource.split('\n'));
      logLines = httpSource.split('\n');
    }
  }
  const inheritedText = inherited.map(r => directiveText(r, logLines)).join('\n');
  if (source.includes(marker)) {
    const markerLine = lines.findIndex(line => line.includes(marker)), diagLine = instrumentation[0]?.words[0].line - 1;
    const prefix = lines.slice(markerLine + 1, diagLine).join('\n');
    if (source.split(marker).length !== 2 || markerLine !== locationLine + 1 || !source.includes(tail)
      || instrumentation.length !== 3 || instrumentation.some(r => r.contextIds.at(-1) !== target.blockId)
      || replacements.some(r => r.original !== r.next) || !canonical(localLogs)
      || (prefix && prefix !== inheritedText)) throw Error('NGINX_DIAGNOSTIC_CONFLICT');
    return { candidate: source, sourceSha256: expectedSha256, candidateSha256: expectedSha256, changed: false, role };
  }
  if (source.includes('lk_game_read_') || instrumentation.length) throw Error('NGINX_DIAGNOSTIC_CONFLICT');
  if (!canonical(localLogs.length ? localLogs : inherited)) throw Error('NGINX_EXPLICIT_CANONICAL_LOG_REQUIRED');
  localLogs.forEach(r => directiveText(r, lines));
  replacements.forEach(r => { lines[r.line] = lines[r.line].replace(r.original, r.next); });
  const prefix = localLogs.length ? '' : inheritedText + '\n';
  lines.splice(locationLine + 1, 0, `${marker}\n${prefix}${tail}`.trimEnd());
  const candidate = lines.join('\n');scanNginxInventoryStructure(candidate);
  return { candidate, sourceSha256: expectedSha256, candidateSha256: sha256(candidate), changed: true, role };
}
