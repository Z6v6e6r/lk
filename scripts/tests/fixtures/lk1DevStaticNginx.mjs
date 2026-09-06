export const devManifestLocation = `    location = /lk/release-dev.json {
        try_files $uri =404;
        add_header Cache-Control "no-store" always;
    }
`;
export const reserveDevServer = (name, port) => `server {
    listen ${port};
    server_name ${name};
    root /var/www/html;
${devManifestLocation}
    location = /lk/release.json { try_files /lk/release$lk_dev_suffix.json =404; }
    location = /lk/bundle.js { try_files /lk/bundle$lk_dev_suffix.js =404; }
    location = /lk/subscription-bookings { return 200 "backend-preserved"; }
    location /lk/ { try_files $uri =404; }
}
`;
export const reserveDevNginx = reserveDevServer('lk-reserve.tsup.space', 18081)
  + reserveDevServer('lk-reserve.89-108-64-209.sslip.io', 18082);
