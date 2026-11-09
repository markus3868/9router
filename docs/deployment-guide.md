# Deployment Guide

_Last updated: 2026-11-05_

## Runtime Summary

9Router runs as a Next.js standalone server on port `20128` by default. It persists local state in `DATA_DIR` when configured, or falls back to `~/.9router` on Unix-like systems and `%APPDATA%\\9router` on Windows.

## Local Development

```bash
npm install
npm run dev
```

Default dev URL:

```text
http://localhost:20128
```

## Required Environment

Minimum expected variables:

```bash
JWT_SECRET=change-me-to-a-long-random-secret
INITIAL_PASSWORD=change-me
DATA_DIR=/var/lib/9router
```

Useful runtime variables:

```bash
PORT=20128
NODE_ENV=production
API_KEY_SECRET=endpoint-proxy-api-key-secret
MACHINE_ID_SALT=endpoint-proxy-salt
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
AUTH_COOKIE_SECURE=false
REQUIRE_API_KEY=false
BASE_URL=http://localhost:20128
CLOUD_URL=https://9router.com
NEXT_PUBLIC_BASE_URL=http://localhost:20128
NEXT_PUBLIC_CLOUD_URL=https://9router.com
TELEGRAM_POLL_TIMEOUT_SECONDS=25
# Optional local/dev controls. Default package still uses embedded bot token.
# TELEGRAM_DISABLED=1
# TELEGRAM_BOT_DISABLED=1
# TELEGRAM_BOT_TOKEN_OVERRIDE=123456:local-dev-token
```

Optional outbound proxy variables:

```bash
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
ALL_PROXY=socks5://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
```

## Production Build

```bash
npm install
npm run build
npm start
```

Notes:

- `PORT=20128 npm start` boots the custom Next server from the source checkout; without `PORT`, the package start script defaults to `20127`.
- `npm run build` copies `.next/static`, `public/`, and the custom server into `.next/standalone/`.
- Existing local LaunchAgent deployments can keep using `scripts/start-standalone.js`, which syncs assets before startup. Local Telegram remains disabled; the server keeps its own Telegram environment.

## Systemd Example

```ini
[Unit]
Description=9Router
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/9router
EnvironmentFile=/home/ubuntu/9router/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Docker

Published image:

- `decolua/9router:latest`

Quick start:

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  decolua/9router:latest
```

Notes:

- Container image uses Next standalone output
- The image copies `open-sse` and `src/mitm` explicitly for runtime completeness
- Persistent DB path inside container is `/app/data/db/data.sqlite`

## Health and Operations

- Health route: `/api/health`
- Version routes: `/api/version/*`
- Tunnel control: `/api/tunnel/*`
- Request logs and usage stats: `/api/usage/*`

## Operational Caveats

- `src/lib/usageDb.js` still writes legacy usage files outside the main SQLite path
- Tunnel and MITM features may need extra OS-level permissions or installed binaries
- Some provider integrations depend on OAuth or cookie sessions that may be unstable or risky
- Telegram bot polling is single-instance only when packaging this build, because the bot token is embedded in the artifact; local/dev runs can set `TELEGRAM_DISABLED=1` to disable all Telegram behavior, `TELEGRAM_BOT_DISABLED=1` to disable polling only, or `TELEGRAM_BOT_TOKEN_OVERRIDE` to use a separate bot
- Telegram commands work from private chats and group chats that have a real `from.id`
- Telegram bot supports `/key`, `/report`, and `/report7`
- Telegram-managed API keys are active only on Monday-Friday, `08:00-18:30` in `Asia/Ho_Chi_Minh`
- Endpoint → API Keys → `Enable Use Working Hour` controls that Telegram schedule globally. Enabled is the default; disabling it lets Telegram-managed keys work outside the schedule while preserving manual and temporary disables.
- Telegram-managed API keys send one daily warning after reaching `400 USD` or `180M` tokens, and are temporarily disabled until the next business-day `08:00` after reaching `1000 USD` or `600M` tokens
- Endpoint → API Keys can manually send a Telegram warning, temporarily disable a Telegram-managed key until the next business-day `08:00`, or clear that temporary disable early; clearing also raises that key's hard limit for the current Vietnam day by another `1000 USD` / `600M` tokens to avoid immediate re-disable
- `/report` and `/report7` show `Quota Remaining Today` for weekly quotas as the current workday burn budget remaining after excluding future weekend days; a fixed `10%` safety buffer is deducted silently
- On Saturday and Sunday in Vietnam time, `/key`, `/report`, and `/report7` reply with a short weekend rest greeting instead of returning a key or report
- In Endpoint settings, API keys can optionally force a single model from the current Available Models list; when set, client-supplied model names are ignored for model-based API routes except `/v1/images/generations`, which preserves the image-capable model selected by the media client
- Provider thinking settings are defaults only: explicit client reasoning (including Responses `reasoning.effort`) takes priority. Codex normalizes unsupported efforts to the target model's supported levels; forcing an API key's model does not change the client's advertised effort options.
- `/key` still requires the sender to have a Telegram `username`; `/report` and `/report7` do not
- Telegram clients that support bot command menus will show `/key`, `/report`, and `/report7` from the native slash-command menu

## Telegram Reports Across Local Instances

For independent instances on the same host, set this only on the instance polling the bot:

```bash
TELEGRAM_REPORT_DATA_DIRS=/home/ubuntu/.9router-20125,/home/ubuntu/.9router-20126,/home/ubuntu/.9router-20127,/home/ubuntu/.9router-20129
```

- Requires Node.js 22.13+ with `node:sqlite` and read access to each peer's `db/data.sqlite` and SQLite WAL files.
- The bot includes its own `DATA_DIR` automatically. Duplicate paths and symlinks are counted once.
- `/report` and `/report7` combine tokens, cost, requests, and percentages by Telegram user ID, using Vietnam calendar-day windows.
- Each user row uses `username: 123,456 tokens - cx/model`, listing the distinct models actually used in that report window (across all configured instances), not the key's currently configured forced model. Usage percentages and costs are not displayed.
- Identical cloned history rows are counted once across databases; independent requests remain separate.
- Quota remains the polling instance's current upstream snapshot, not the sum of duplicate account quotas.
- Missing/unreadable sources produce an incomplete-data notice in the report.
- DBs, API keys, and daily usage-limit enforcement remain independent. This setting aggregates reports only.
- Keep `TELEGRAM_BOT_DISABLED=1` on peer instances. Local development can keep `TELEGRAM_DISABLED=1` and omit the report setting.

## Shared Telegram Configuration

On peers (20125, 20126, 20127, 20129), set:

```bash
TELEGRAM_CONFIG_SOURCE_DATA_DIR=/home/ubuntu/.9router
```

- Change Telegram users' forced models and `Enable Use Working Hour` on the primary dashboard (20128).
- Peers read these values directly from the primary SQLite database in read-only mode; the next request sees committed changes without restarting.
- Requires same-host Node.js 22.13+ and read access to the primary database and WAL files. An unavailable source fails requests rather than silently using stale permissions.
- Model overrides match Telegram user IDs, not usernames or local key IDs. Clearing a model on the primary also clears the effective override on peers.
- Peer dashboards show effective values. Conflicting model/working-hour edits on peers return HTTP 409 and direct the user to the primary.
- Manual keys, other settings, usage history, manual/temporary disables, and daily limits remain local. No keys or usage records are copied or created.
- Omit this setting for independent/local instances. Pointing it at the instance's own data directory has no effect.

## Recommended Deployment Checks

1. Confirm login works with the configured `JWT_SECRET` and `INITIAL_PASSWORD`
2. Confirm `DATA_DIR` is writable
3. Confirm `/api/health` responds after startup
4. Add at least one provider and run a request through `/v1/chat/completions`
5. If using remote access, verify tunnel or Tailscale recovery behavior after restart
