# Slice 1 research notes, 2026-11-11

These are short notes from three research lanes. The main session checked the local facts itself.

## quivly-app run anatomy
- **Web app:** `bun dev` at the repo root runs `nx run quivly-app:dev`, which runs `bun run build:mcp-app && next dev`.
  - Next 16.4.5 with Turbopack. Next reads its port from `PORT`.
- **Inngest:** v1 runs `inngest-cli dev -p <app+5288> -u http://localhost:<app>/api/inngest --no-discovery` (`~/.setu/portal.js:2277-2315`).
  - The app is in dev mode when `INNGEST_DEV` is set. Otherwise it uses cloud mode when `INNGEST_SIGNING_KEY` is set (`apps/quivly-app/lib/inngest/is-dev.ts`).
  - v1 never sets `INNGEST_BASE_URL`.
- **Trigger.dev:** v1 runs `bunx trigger.dev@<sdk> dev --max-concurrent-runs 2 [--branch]`, with `.env.local` passed to the worker. The branch env goes to the app too.
  - Checked: `@trigger.dev/core` 4.8.3 reads `TRIGGER_DEV_BRANCH`.
  - The worktree has no local `trigger` binary.
- **Convex:** not used by quivly-app.
- **`.env.local`:** symlinked from main's.
- **Next `allowedDevOrigins`:** includes `*.quivly.local` and `*.setu.local`.
- **WorkOS:** `resolveRedirectUri` (`apps/quivly-app/lib/auth/resolve-redirect-uri.ts`) trusts `*.quivly.local` and `*.setu.local` and keeps the port. Callbacks still need registering in WorkOS.

## Proxy behaviour (vendor docs and framework source)
- **Next `allowedDevOrigins`:**
  - Checks only the Origin hostname, on `/_next` and `/__nextjs` paths.
  - `**.localhost` is built in.
  - `*` matches one label; `**` matches one or more labels and only at the start of a pattern.
- **Next Server Actions:** compare the Origin host:port against `x-forwarded-host`, falling back to `host`. Preserve Host and forward Host with the port included.
- **Vite:** `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`. `.localhost` is allowed by default.
- **Rails:** `RAILS_DEVELOPMENT_HOSTS`. `.localhost` and `.test` are allowed by default.
- **Django:** `ALLOWED_HOSTS`. `.localhost` is allowed when DEBUG is on.
- **Phoenix:** `check_origin`.
- **Proxy defaults:**
  - Preserve Host and Origin.
  - Overwrite `X-Forwarded-For/Proto/Host/Port`.
  - Stream request and response bodies without buffering.
  - No read timeout on upgraded connections.
  - Return 502 with a readable page.

## Rust building blocks (read from pitchfork v2.34.0 source, MIT)
- **Forwarding:** `src/proxy/server.rs:2925-3330`.
  - Upgrades come from `hyper::upgrade::on` on both sides, then `copy_bidirectional`.
  - Serve with `serve_connection_with_upgrades`.
  - Set the request to HTTP/1.1 before sending it to the client.
- **Activity tracking:** `src/proxy/activity.rs`. `Mutex<HashMap<id, {in_flight, last_activity, idle_stopping}>>`, plus `ActivityGuard`, `GuardedBody` and `claim_idle_stop`/`release_idle_stop`.
- **Stopping processes:** `src/procs.rs:425-540` sends `killpg` TERM, waits a grace period, then KILL. It guards pids by start time.
- **DNS:** `src/proxy/dns.rs` `handle_query` is a hand-rolled A/AAAA responder. It answers REFUSED outside its TLD and binds `127.0.0.1:15353`. The resolver file is `/etc/resolver/<tld>` with `nameserver 127.0.0.1` and `port 15353`.
- **Crates:**

  | Crate | Version | Features |
  |---|---|---|
  | tokio | 1.54.1 | current_thread |
  | hyper | 1.12.0 | |
  | hyper-util | 0.1.21 | client-legacy, server, tokio, http1 |
  | http-body-util | 0.1.5 | |
  | process-wrap | 10.0.1 | tokio1, process-session, kill-on-drop |
  | libc | 0.2.191 | |
  | serde_json | | |

  `proc_pid_rusage` with `RUSAGE_INFO_V4` gives `ri_phys_footprint`.
- **Avoid:** axum, sysinfo, hickory, interprocess, listeners, tokio `full`.
- **Socket path:** macOS `sun_path` is 104 bytes, so keep the socket name short (`d.sock`).
- **launchd:** set PATH in `EnvironmentVariables`, and set `AbandonProcessGroup` if children must outlive the daemon.

## Checked on this machine (2026-11-11)
- Binding port 81 as an ordinary user works on `0.0.0.0` and fails on `127.0.0.1` and `::1`.
- Caddy (v1) holds `*:80`.
- dnsmasq resolves `*.quivly.local` to 127.0.0.1.
- macOS 26.6.2 resolves `*.localhost` natively.
- Running v1 dev servers: 3010 (`feat/simpler-approvals`), 3013 (`feat/knowledge-display-only`), 3081 (`unified-harness-build`).
