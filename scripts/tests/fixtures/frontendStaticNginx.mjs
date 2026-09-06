export const legacyReleaseLocation = `    location = /lk/release.json {
        root /var/www/html;
        try_files $uri =404;
        add_header Cache-Control "no-store" always;
        if ($request_method = OPTIONS) { return 204; }
    }
`;
export const legacyStaticServer = `server {
    listen 127.0.0.1:18080;
    server_name fixture.invalid;
${legacyReleaseLocation}
    location = /lk/subscription-bookings { return 200 "backend-contract-preserved"; }
    location ^~ /lk/ {
        alias /var/www/html/lk/;
        try_files $uri $uri/ =404;
    }
}
`;
