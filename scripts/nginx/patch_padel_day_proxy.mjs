import fs from "node:fs";
import path from "node:path";

const configPath = path.resolve(process.argv[2] || "/etc/nginx/sites-enabled/padlhub.su");
const source = fs.readFileSync(configPath, "utf8");

if (source.includes("location ^~ /lk/padel-day/")) {
  console.log(`Padel Day proxy already exists in ${configPath}`);
  process.exit(0);
}

const marker = "    location ^~ /lk/ {\n        alias /var/www/html/lk/;";
const proxy = `    location ^~ /lk/padel-day/ {
        proxy_pass http://127.0.0.1:1880;
        proxy_hide_header Access-Control-Allow-Origin;
        proxy_hide_header Access-Control-Allow-Methods;
        proxy_hide_header Access-Control-Allow-Headers;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
        if ($request_method = OPTIONS) { return 204; }
    }

`;

if (!source.includes(marker)) throw new Error(`Static /lk/ marker is missing in ${configPath}`);
const next = source.replace(marker, `${proxy}${marker}`);
const backupPath = `${configPath}.backup-padel-day-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}`;
fs.copyFileSync(configPath, backupPath);
const tempPath = `${configPath}.tmp-padel-day-${process.pid}`;
fs.writeFileSync(tempPath, next, "utf8");
fs.renameSync(tempPath, configPath);
console.log(JSON.stringify({ ok: true, configPath, backupPath }, null, 2));
