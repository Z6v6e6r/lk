import {validatePrivatePreparationPaths} from '../lib/privatePreparationPaths.mjs';
/** Offline only. No network, apply, reload or service command. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const limits = `    limit_req zone=lk_community_ip burst=20 nodelay;
    limit_req zone=lk_community_global burst=10 nodelay;
    limit_req_status 429;
    limit_conn lk_community_conn_ip 6;
    limit_conn lk_community_conn_global 30;
    limit_conn_status 429;
`;
const headers = 'Content-Type, Authorization, X-API-Key, Idempotency-Key, X-Correlation-ID';
function range(source, header) {
  const needle = new RegExp('^([ \\t]*)location\\s+' + header + '\\s*\\{[^\\S\\n]*$', 'gm');
  const matches = [...source.matchAll(needle)];
  if (matches.length !== 1) throw new Error('EVENT_NGINX_LOCATION_DRIFT');
  const start = matches[0].index, open = source.indexOf('{', start);
  let depth = 1, quote = '', comment = false, escape = false;
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i];
    if (comment) { if (c === '\n') comment = false; continue; }
    if (escape) { escape = false; continue; }
    if (quote) { if (c === '\\') escape = true; else if (c === quote) quote = ''; continue; }
    if (c === '#' ) { comment = true; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return {start, end:i + 1, open};
  }
  throw new Error('EVENT_NGINX_UNBALANCED');
}
export function buildEventCommunityGuard(source, expectedSha256, origins) {
  if (sha256(source) !== expectedSha256) throw new Error('EVENT_NGINX_SOURCE_SHA_MISMATCH');
  if (!Array.isArray(origins) || !origins.length || origins.length > 8 || new Set(origins).size !== origins.length || origins.some(value => {
    try { const url = new URL(value); return url.protocol !== 'https:' || url.origin !== value || !!url.username || !!url.password || /[\s"'{};\\]/.test(value); } catch { return true; }
  })) throw new Error('EVENT_NGINX_ORIGIN_INVALID');
  const http = `# EVENT_COMMUNITY_GUARD_V1: http context, before the vhost\nmap $http_origin $lk_event_origin {\n    default "";\n${origins.map(origin => `    "${origin}" "${origin}";`).join('\n')}\n}\nmap $http_x_correlation_id $lk_event_correlation {\n    default $request_id;\n    "~^[A-Za-z0-9._-]{1,80}$" $http_x_correlation_id;\n}\nlimit_req_zone $binary_remote_addr zone=lk_community_ip:10m rate=60r/m;\nlimit_req_zone $server_name zone=lk_community_global:1m rate=10r/s;\nlimit_conn_zone $binary_remote_addr zone=lk_community_conn_ip:10m;\nlimit_conn_zone $server_name zone=lk_community_conn_global:1m;\n`;
  const common = `# EVENT_COMMUNITY_PROXY_V1\n${limits}    client_body_timeout 10s;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
    proxy_send_timeout 15s;
    proxy_request_buffering on;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Idempotency-Key $http_idempotency_key;
    proxy_set_header X-Correlation-ID $lk_event_correlation;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header X-Correlation-ID;
    add_header Access-Control-Allow-Origin $lk_event_origin always;
    add_header Access-Control-Allow-Headers "${headers}" always;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
    add_header Access-Control-Expose-Headers "X-Correlation-ID" always;
    add_header Vary Origin always;
    add_header X-Correlation-ID $lk_event_correlation always;
    add_header Cache-Control "private, no-store" always;
    access_log off;
    if ($request_method = OPTIONS) { return 204; }
    if ($request_method !~ ^(GET|POST|OPTIONS)$) { return 405; }
    proxy_pass http://127.0.0.1:1880;
`;
  const marker = '# EVENT_COMMUNITY_LOCATIONS_V1';
  const nested = `\n    ${marker}\n    location ~ ^/lk/communities/[^/]+/event-game/finish$ {\n        client_max_body_size 192k;\n        include /etc/nginx/snippets/lk-event-community-proxy.conf;\n    }\n    location ~ ^/lk/communities/(?:[^/]+/add-member|join-by-invite|[^/]+/event-game/(?:start|ranking))$ {\n        client_max_body_size 8k;\n        include /etc/nginx/snippets/lk-event-community-proxy.conf;\n    }\n`;
  const targets = [range(source, '=\\s+/lk/communities'), range(source, '\\^~\\s+/lk/communities/')].sort((a,b)=>b.start-a.start);
  let candidate = source;
  for (const target of targets) {
    let block = source.slice(target.start, target.end);
    if (block.includes(marker)) {
      if ((!block.includes(nested) && source.slice(target.start,target.open).includes('^~'))) throw new Error('EVENT_NGINX_MANAGED_DRIFT');
      continue;
    }
    if (/\blimit_(req|conn)\b|\binclude\b|\blocation\s/.test(block.slice(block.indexOf('{') + 1))) throw new Error('EVENT_NGINX_UNREVIEWED_LIMITS_OR_NESTING');
    if (!block.includes('proxy_pass') || !/Access-Control-Allow-Headers\s+"Content-Type, Authorization, X-API-Key"\s+always;/.test(block)) throw new Error('EVENT_NGINX_PROXY_OR_CORS_DRIFT');
    block = block.replace(/Access-Control-Allow-Headers\s+"Content-Type, Authorization, X-API-Key"\s+always;/, `Access-Control-Allow-Headers "${headers}" always;`);
    if (source.slice(target.start,target.open).includes('^~')) block = block.slice(0,-1) + nested + '}';
    else block = block.slice(0,-1) + '\n    ' + marker + '\n}';
    candidate = candidate.slice(0,target.start) + block + candidate.slice(target.end);
  }
  return {candidate, http, common, sourceSha256:expectedSha256, candidateSha256:sha256(candidate), changed:candidate!==source};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, out, expected, ...origins] = process.argv.slice(2);
  if (!source || !out || !expected || !path.isAbsolute(out)) throw new Error('Usage: node prepare_event_community_guard.mjs SOURCE OUT_DIRECTORY EXPECTED_SHA ORIGIN...');
  validatePrivatePreparationPaths(path.resolve(source),path.resolve(out));
  const result = buildEventCommunityGuard(fs.readFileSync(source,'utf8'),expected,origins);
  fs.mkdirSync(out,{mode:0o700});
  for (const [name,body] of Object.entries({'vhost.candidate.conf':result.candidate,'lk-event-community-http.conf':result.http,'lk-event-community-proxy.conf':result.common})) fs.writeFileSync(path.join(out,name),body,{mode:0o600,flag:'wx'});
  const manifest={sourceSha256:result.sourceSha256,candidateSha256:result.candidateSha256,httpSha256:sha256(result.http),proxySha256:sha256(result.common),deployed:false};
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'}); console.log(JSON.stringify(manifest));
}
