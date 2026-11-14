import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LOCATION = `    # padlhub-max-inbound-v1: independent authenticated receiver
    location = /integrations/max/padlhub/webhook {
        if ($request_method != POST) { return 405; }
        client_max_body_size 64k;
        proxy_pass http://127.0.0.1:18941/webhook;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Connection "";
        proxy_set_header X-Max-Bot-Api-Secret $http_x_max_bot_api_secret;
        proxy_connect_timeout 2s;
        proxy_send_timeout 10s;
        proxy_read_timeout 25s;
    }

`;
export function patchNginx(raw, expectedSha) {
  if (crypto.createHash('sha256').update(raw).digest('hex') !== expectedSha) throw Error('NGINX_SOURCE_DRIFT');
  const text = raw.toString('utf8'), anchors = [...text.matchAll(/^[\t ]*location \^~ \/api\/ \{\r?$/gm)];
  if (text.includes('/integrations/max/padlhub/webhook') || anchors.length !== 1) throw Error('NGINX_SHAPE');
  const anchor = anchors[0][0];
  return Buffer.from(text.replace(anchor, LOCATION + anchor));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) throw Error('ARGUMENTS');
  fs.writeFileSync(process.argv[4], patchNginx(fs.readFileSync(process.argv[2]), process.argv[3]), { flag: 'wx', mode: 0o600 });
}
