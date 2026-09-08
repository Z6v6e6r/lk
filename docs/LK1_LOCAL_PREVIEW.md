# Local LK1 Docker preview

Owner: current LK1 development task. Audience: local UI development on this Mac.
Source: the task branch based on fetched LK1 `origin/main`, not the older primary checkout.

Run `npm run local:up` from this worktree, then open http://127.0.0.1:5180.
Edits to `src` are picked up by Vite. `npm run local:status` reads container health;
`npm run local:stop` stops only this Compose project. Other LK2 projects are not touched.

## Current boundary

This initial preview is **offline**. It renders the existing LK1 application and login
screen but does not send SMS codes, exchange tokens, load private production data,
confirm payments, create invitations, or change bookings. The visible banner states
this limitation. Do not describe it as an authenticated production-data test.

The Vite container is attached only to an internal Docker network. A separate small
entry container exposes loopback port 5180 and forwards only to the fixed `web:5173`
target; it has no production proxy, arbitrary upstream, or CONNECT support. This
entry network is needed because Docker Desktop does not publish the internal-only
Vite network directly. Both containers run as `node` with a read-only filesystem, no capabilities,
no Docker socket, and no production environment or credential mounts. Only package
manifests are sent to the dependency image build. Source directories are mounted
read-only; caches are bounded temporary filesystems. Production Vite config is not used.
The ARM64 image installs the Linux ARM64 Rollup binary at the existing locked Rollup
version, matching the repository CI's explicit Linux x64 optional-dependency repair.
The root dependency manifest and lock are not changed by that image-only repair.

Browser CSP blocks external scripts, connections, images, forms, workers, and frames.
The application is inside a local frame that cannot open popups or navigate the top
page; external frame navigation is blocked. A pre-bootstrap guard returns an explicit
local error for external fetches and blocks other write transports. Server-side
middleware independently rejects non-GET/HEAD requests and cross-site origins.

The local `/__lk1_local/status` endpoint reports only mode and aggregate blocked
request counts. It never records URLs, request bodies, tokens, or personal data.

## Pending connection

An automatic approval review rejected the proposed production-data proxy with
SMS/token forwarding. That code was not installed. Connecting a real account requires
an explicitly authorized and reviewed next change, including safe read routes,
subject binding, interactive authentication exceptions, rate limits, and proof that
background writes and direct browser requests cannot bypass the gateway.

Stop signal: any unexpected external request or enabled business command. Stop with
`npm run local:stop`. Stopping the container removes no other task's services or data.
