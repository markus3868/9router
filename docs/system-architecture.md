# System Architecture

_Last updated: 2026-09-15_

## Summary

9Router is a local AI gateway composed of a Next.js dashboard/API layer, a shared routing and translation core in `open-sse`, a local persistence layer, and optional remote-access helpers such as Cloudflare Tunnel, Tailscale, and MITM support.

Detailed runtime notes remain in `docs/ARCHITECTURE.md`. This file is the shorter canonical architecture summary for day-to-day delivery work.

## Main Runtime Layers

### 1. App Shell and HTTP Entry Points

- `src/app/*` serves the landing page, login flow, and dashboard
- `src/app/api/*` exposes dashboard management APIs
- `next.config.mjs` rewrites `/v1/*` into compatibility routes under `src/app/api/v1/*`
- `src/app/api/init/route.js` calls `src/lib/runtime/startup.js` for explicit runtime bootstrap
- `src/instrumentation.js` boots singleton runtime services such as startup recovery, Telegram polling, and scheduled API-key reconciliation

### 2. Compatibility Handlers

- `src/sse/handlers/chat.js`
- `src/sse/handlers/embeddings.js`
- `src/sse/handlers/search.js`
- `src/sse/handlers/imageGeneration.js`
- `src/sse/handlers/tts.js`
- `src/sse/handlers/stt.js`
- `src/sse/handlers/fetch.js`

These handlers validate request shape, resolve model/provider context, and delegate into the shared execution core.

### 3. Shared Routing Core

- `open-sse/handlers/*`
- `open-sse/executors/*`
- `open-sse/translator/*`
- `open-sse/services/*`
- `open-sse/utils/*`

This layer handles:

- upstream auth and request execution
- provider-specific request translation
- streaming normalization
- account fallback
- combo routing
- usage extraction

### 4. Persistence

- Main app state lives in SQLite via `src/lib/db/*`
- Runtime path is derived from `DATA_DIR` or falls back to `~/.9router`
- Main entities include settings, provider connections, nodes, API keys, combos, usage history, request details, and KV metadata
- Legacy usage/log storage still exists in `src/lib/usageDb.js`
- Telegram bot polling state stores its `lastUpdateId` in the `kv` table under scope `telegramBot`

### 5. Process and Connectivity Services

- `src/shared/services/initializeApp.js` handles runtime bootstrap
- `src/lib/tunnel/*` manages Cloudflare Tunnel and Tailscale
- `src/mitm/*` manages MITM server, certs, and DNS hooks
- `src/lib/network/*` handles outbound proxy support and connectivity helpers
- `src/lib/telegram/*` handles Telegram polling, `/key`, `/report`, `/report7`, native command-menu sync, Telegram-specific quota/usage reports, daily usage limit notifications, and manual dashboard warning/temporary-disable/resume actions. Manual resume stores a current-day KV limit override so the next request is not disabled again by already-exceeded totals.
- `settings.telegramWorkingHoursEnabled` is the global switch for Telegram API-key working-hour enforcement; API-key validation and schedule reconciliation read it directly.

## Key Architectural Decisions

- Local-first state instead of a required remote backend
- OpenAI-compatible downstream contract even when upstreams differ
- Adapter-based DB runtime selection for better portability
- Provider metadata centralized in one catalog file with execution split into specialized modules
- Operational features such as tunnel and MITM kept inside the same app process boundary

## Known Architectural Gaps

- Root README is not aligned with the real product
- Legacy usage/log persistence is not fully unified with `DATA_DIR`
- Provider metadata and service definitions are concentrated in a very large constants file
- Automated regression coverage around translation and compatibility contracts is still limited
