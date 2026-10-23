import fs from 'node:fs';
import {buildEventCommunityGuard,sha256} from '../nginx/prepare_event_community_guard.mjs';
const root=process.argv[2];if(!root?.startsWith('/')) throw new Error('Absolute synthetic output directory required');fs.mkdirSync(root,{recursive:true});
const block=route=>`location ${route} {\nproxy_hide_header Access-Control-Allow-Origin;\nadd_header Access-Control-Allow-Origin "*" always;\nadd_header Access-Control-Allow-Methods "GET, POST, PATCH, OPTIONS" always;\nif ($request_method = OPTIONS) { return 204; }\nadd_header Access-Control-Allow-Headers "Content-Type, Authorization, X-API-Key" always;\nproxy_pass http://127.0.0.1:1880;\n}`;
const source=`server {\nlisten 8080;\nserver_name localhost;\nlocation = /unrelated {return 200 'unrelated';}\n${block('= /lk/communities')}\n${block('^~ /lk/communities/')}\n}`;
const result=buildEventCommunityGuard(source,sha256(source),['https://padlhub.ru','https://padlhub.su']);
fs.writeFileSync(root+'/http.conf',result.http);fs.writeFileSync(root+'/proxy.conf',result.common);
fs.writeFileSync(root+'/nginx.conf',`pid /tmp/event-nginx.pid;\nerror_log /tmp/event-nginx-error.log warn;\nevents {worker_connections 128;}\nhttp {\ninclude /etc/nginx/event-test/http.conf;\n${result.candidate}\n}`);
console.log(JSON.stringify({sourceSha256:result.sourceSha256,candidateSha256:result.candidateSha256,synthetic:true}));
