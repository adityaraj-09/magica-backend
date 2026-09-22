# Galaxy Agent Backend

Production agent-chat API for the Galaxy work trial. This repo is the backend half of a two-repo split: durable orchestration, tools, credits, and REST. The frontend is a separate Next.js app that consumes these routes.

## Setup

```bash
pnpm install
cp .env.example .env
```

Required env (no code defaults for credits):

- `DATABASE_URL`
- `CREDIT_GRANT_INITIAL` — opening ledger grant on first Clerk login
- `CREDIT_RESERVE_TURN` — debit reserved at send, settled later against tool cost
- `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `OPENROUTER_API_KEY` — model must stay `openrouter/free`
- `MAGICA_API_KEY`
- `E2B_API_KEY`
- `TRIGGER_SECRET_KEY` / `TRIGGER_PROJECT_REF`
- `TRANSLOADIT_KEY` / `TRANSLOADIT_SECRET`

Optional: `EXA_API_KEY` (otherwise web search is stubbed), `S3_*` (R2-compatible copy of Magica/E2B result URLs; empty keeps ephemeral provider URLs).

```bash
pnpm db:migrate
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/sql/0001_constraints.sql
pnpm trigger:dev   # separate terminal
pnpm dev           # http://localhost:3000
```

```bash
pnpm test
pnpm typecheck
MAGICA_LIVE=1 pnpm test:magica-live   # real Magica crop / GPT Image 2 / merge / generate-then-crop
```

## Architecture

One authenticated send starts one durable Trigger.dev orchestrator run (`concurrencyKey=chatId`, `idempotencyKey=messageId`). PostgreSQL is the source of truth; Trigger Realtime is transport. The loop restores history, calls OpenRouter Free with `ToolRegistry.listForAgent()`, executes Magica/E2B/Exa as child tasks, and stops at a terminal message or a PLAN/CREDIT/MEDIA waitpoint.

```
POST /api/chats/:id/messages
  → reserve credits + persist Message/AgentRun
  → orchestrateAgentTurn
       → OpenRouter Free (tools)
       → Magica / E2B / Exa child tasks
       → copy result URLs into R2/S3
       → settle ledger (hold first, then overage)
```

Inbound user media goes through Transloadit Community (signed Assembly params, Uppy later). Outbound generated assets are copied to object storage so Magica/E2B URLs survive expiry. Skills live in `agent-skills/*/SKILL.md` and are loaded on demand.

## Product routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/me` | Balance |
| GET | `/api/me/ledger` | Cursor-paginated credit ledger |
| GET/POST | `/api/chats` | List / create |
| GET/PATCH/DELETE | `/api/chats/:chatId` | Ownership on every mutation |
| GET/POST | `/api/chats/:chatId/messages` | History; send (`attachmentIds`, rate limit) |
| GET | `/api/chats/:chatId/runs/:runId` | Snapshot + REST fallback |
| POST | `/api/chats/:chatId/runs/:runId/cancel` | STOPPING then Trigger cancel |
| POST | `/api/chats/:chatId/waitpoints/:id` | Complete PLAN/CREDIT/MEDIA |
| GET | `/api/attachments` | Media library (complete, unexpired) |
| POST | `/api/chats/:chatId/uploads/sign` | Transloadit signed params |
| POST | `/api/chats/:chatId/uploads/complete` | Persist Assembly files |
| GET/POST | `/api/keys` | List / create public API keys (`gxk_live_…` shown once) |
| DELETE | `/api/keys/:keyId` | Revoke a key |
| GET/POST | `/api/webhook-endpoints` | List / create signed webhook endpoints |
| DELETE | `/api/webhook-endpoints/:endpointId` | Delete an endpoint |

Send is limited by `SEND_RATE_LIMIT_PER_MINUTE` (default 20 / 60s), counted as `AgentRun` rows for that user. Duplicate `clientMessageId` replays without a second reserve or rate-limit hit. `attachmentIds` must be owned, `COMPLETE`, and unexpired; same-chat files are `DIRECT_UPLOAD`, others `MEDIA_LIBRARY`.

## Public API (`/api/v1`)

Bearer API keys (`POST /api/keys`, `Authorization: Bearer gxk_live_…`). Clerk is skipped for `/api/v1`.

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/api/v1/chats` | List / create |
| GET/DELETE | `/api/v1/chats/:chatId` | Read / soft-delete |
| GET/POST | `/api/v1/chats/:chatId/messages` | History / send |
| POST | `/api/v1/chats/:chatId/completions` | Chat-style admit (`text` / `prompt` / `messages`) |
| POST | `/api/v1/completions` | Creates a chat when `chatId` is omitted |
| GET | `/api/v1/chats/:chatId/runs/:runId` | Poll run status |
| POST | `/api/v1/tools/{crop_image,gpt_image_2,merge_videos}` | Magica, waits on the provider |

Outbound webhooks: `POST /api/webhook-endpoints` (secret shown once). Events `agent.started` / `agent.completed` / `agent.failed` / `tool.completed`, HMAC-SHA256 over `${timestamp}.${body}`. Delivery retries 4 times (immediate, then 1s, 5s, 15s) and marks the row `FAILED` only after the last attempt.

## MCP

`POST /api/mcp` is a stateless MCP endpoint (Streamable HTTP, JSON responses). Same Bearer API key as `/api/v1`. Tools: `list_chats`, `get_chat`, `create_chat`, `delete_chat`, `list_messages`, `send_message`, `complete`, `get_run`, `crop_image`, `gpt_image_2`, `merge_videos`. Clerk is skipped for this route.

Mintlify source is `docs/` (`docs.json` + MDX). Host with `npx mintlify dev` or deploy that folder.

## Design trade-offs

- **Orchestrator + child tasks, not one giant task.** Magica polls can run minutes; isolating them keeps retries and cancellation scoped. Postgres still owns run/tool/credit rows so a Trigger retry cannot double-charge.
- **Transloadit is ingest, R2/S3 is durable storage.** Community results expire in 24 hours, cannot be used as a CDN, and would watermark/trim generated media. Magica/E2B bytes are copied into `generated/{chatId}/{runId}/{toolCallId}/…`. A copy failure keeps the ephemeral URL and logs `asset.copy_failed`.
- **Credits have no hidden defaults.** Misconfigured `CREDIT_GRANT_INITIAL` / `CREDIT_RESERVE_TURN` fails closed. OpenRouter usage is recorded at zero application credits.
- **OpenRouter Free only.** 429 / empty stream / malformed tool calls are terminal or retried in-loop; there is no paid fallback.
- **Send rate limit is a Postgres count**, not Redis. It is correct across processes and matches “one active run per chat” as the primary concurrency control. It is not a hot-path token bucket.

## What I would improve with more time

- Frontend repo: chat shell, streaming, Uppy, waitpoint overlays, pixel match against the live product.
- Signed object-storage URLs instead of a public bucket prefix.
- OPTIONS waitpoints and a first-class media-library picker UX.
- Cassette/replay for Magica live tests in CI so success paths do not depend on a live key.
