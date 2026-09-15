# Codebase Summary

_Last updated: 2026-09-15_

## Stack

- Framework: Next.js 16 App Router
- Runtime language: JavaScript ESM
- UI: React 19
- Styling: Tailwind CSS 4 plus CSS variables in `src/app/globals.css`
- Persistence: SQLite with runtime adapter fallback
- Shared routing core: `open-sse/`

## Top-Level Areas

- `src/app/`: App Router pages, layouts, and API routes
- `src/shared/`: reusable UI, constants, hooks, and app boot helpers
- `src/lib/`: persistence, auth, OAuth, tunnel, network, updater, and utility code
- `src/sse/`: request handlers that front the compatibility APIs
- `open-sse/`: provider execution, translation, streaming, fallback, and usage core
- `src/mitm/`: MITM server and certificate tooling
- `skills/`: exported 9Router skills for agent/tool ecosystems
- `gitbook/`: separate docs web app shell
- `docs/`: canonical project documentation

## Request Path Overview

1. Client hits `/v1/*`
2. `next.config.mjs` rewrites that request into `src/app/api/v1/*`
3. Route handler delegates into `src/sse/handlers/*`
4. Shared execution passes into `open-sse/handlers/*` and `open-sse/executors/*`
5. Translator and stream utilities normalize upstream formats back to client-compatible output
6. Usage and request metadata are persisted through `src/lib/db/*` and `src/lib/usageDb.js`

## Main Backend Domains

- `src/app/api/auth/*`: dashboard login/logout/status
- `src/app/api/providers*`: provider connections and validation
- `src/app/api/provider-nodes*`: compatible custom upstream nodes
- `src/app/api/models/*`: aliases, availability, disabled models, custom models
- `src/app/api/combos*`: combo CRUD and fallback strategy management
- `src/app/api/usage/*`: stats, charts, logs, request details
- `src/app/api/tunnel/*`: Cloudflare tunnel and Tailscale controls
- `src/app/api/cli-tools/*`: per-tool config payloads and helper endpoints
- `src/app/api/v1/*`: compatibility endpoints consumed by external clients

## Persistence Layout

- `src/lib/db/`: primary SQLite-backed state layer
- `src/lib/db/schema.js`: declarative schema
- `src/lib/db/repos/*`: table-scoped repository helpers
- `src/lib/db/driver.js`: adapter selection across `better-sqlite3`, `node:sqlite`, `bun:sqlite`, and `sql.js`
- `src/lib/dataDir.js`: resolves `DATA_DIR` with fallback to `~/.9router`
- `src/lib/usageDb.js`: legacy usage/log persistence outside the main DB path

## Frontend Layout

- `src/app/landing/*`: marketing-style landing experience
- `src/app/(dashboard)/*`: authenticated dashboard routes
- `src/shared/components/*`: reusable cards, modals, lists, forms, nav, and layout primitives
- `src/store/*`: Zustand stores for user, settings, theme, notifications, and provider state

## Notable Characteristics

- The repo is JavaScript-first even though an old README still mentions TypeScript
- Provider metadata is centralized in `src/shared/constants/providers.js`
- The provider catalog spans LLM, embeddings, image, TTS, STT, web search, web fetch, and video-related flows
- Runtime bootstrap auto-resumes tunnel, Tailscale, and MITM services when settings require it
- Telegram-managed API-key scheduling is controlled globally by `settings.telegramWorkingHoursEnabled`; the Endpoint page exposes the `Enable Use Working Hour` switch
- There is a deeper technical reference in `docs/ARCHITECTURE.md`
