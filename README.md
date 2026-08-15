# ModelForge

**Self-hosted LLM runtime platform** — serve GGUF models on your own hardware with an OpenAI-compatible API, usage metering, and customer/admin dashboards.

ModelForge is designed for teams that need **data residency** and **CPU-first** inference: model weights never leave your machine, and the default backend needs no C++ toolchain.

```
Browser / SDK  →  Gateway (:3000)  →  llama-server (loopback)
                       ↕
                 PostgreSQL (+ optional Redis)
                       ↕
              Next.js control plane (:3001)
```

## Why ModelForge

| Capability | Detail |
|---|---|
| OpenAI-compatible API | Drop-in `/v1/chat/completions` (streaming + non-streaming) |
| Local GGUF serving | Prebuilt [llama.cpp](https://github.com/ggml-org/llama.cpp) binaries — LM Studio-style, no compiler |
| On-demand loading | Models warm on first request; idle models are LRU-evicted against a RAM budget |
| Multi-tenant control plane | Customer portal (keys, usage, billing) + admin ops (registry, infra, revenue) |
| Metering & billing | Token usage → Postgres (or BullMQ); mock / Stripe / bKash / Nagad adapters |
| Process isolation | Inference stays on loopback; only the gateway is public |

## Stack

| Layer | Technology |
|---|---|
| Control plane | Next.js 16, Tailwind CSS 4, Auth.js |
| API gateway | Express 5, Zod, Prisma |
| Inference (default) | Prebuilt `llama-server` process pool |
| Inference (optional) | Rust gRPC engine with continuous batching |
| Data | PostgreSQL · Redis optional |
| Monorepo | pnpm + Turborepo |

## Repository layout

```
apps/
  gateway/           Public OpenAI-compatible API + llama-server pool
  web/               Customer & admin dashboards
  inference-engine/  Optional Rust + llama.cpp gRPC worker
packages/
  db/                Prisma schema, migrations, seed
  engine/            Shared OpenAI schemas & error types
  billing/           Invoice math + payment adapters
  config/            Shared TS / ESLint config
scripts/             llama:fetch, weights scan, engine status, e2e
infra/               Docker Compose (Postgres/Redis), systemd units
```

## Prerequisites

- **Node.js 20+** and **pnpm 10+**
- **PostgreSQL** (local install or Docker)
- At least one **`.gguf`** model file
- Redis is optional — set `REDIS_ENABLED=false` for local development

No C++ toolchain is required for the default `llama-server` backend.

## Quick start

```bash
# 1. Clone & configure
cp .env.example .env
# Edit .env — set DATABASE_URL, JWT_SECRET, AUTH_SECRET,
# INTERNAL_SERVICE_TOKEN, and an absolute MODEL_WEIGHTS_DIR

# 2. Infrastructure (skip if you already have Postgres)
pnpm infra:up

# 3. Install & database
pnpm install
pnpm db:generate
pnpm db:deploy
pnpm db:seed

# 4. Shared packages
pnpm --filter @modelforge/engine build
pnpm --filter @modelforge/db build
pnpm --filter @modelforge/billing build

# 5. Fetch prebuilt llama.cpp binaries (~18 MB)
pnpm llama:fetch

# 6. Run gateway + web
pnpm dev
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:3001 |
| API | http://localhost:3000/v1 |
| Health | http://localhost:3000/healthz |

### Seed accounts

| Email | Password | Role |
|---|---|---|
| `admin@modelforge.local` | `admin123` | Admin |
| `demo@modelforge.local` | `demo123` | Customer |

The seed prints a one-time demo API key (`mf_…`). **Change all secrets before any public or production deploy.**

## Adding a model

1. Set `MODEL_WEIGHTS_DIR` in `.env` to an **absolute** path (gateway and workers use different working directories, so relative paths resolve incorrectly).
2. Copy a `.gguf` anywhere under that directory (subfolders are scanned).
3. Confirm discovery:

```bash
pnpm weights:scan
```

4. Sign in as admin → **Model Registry** (`/admin/models`):
   - The file appears under **Discovered on disk** → **Register**
   - **Grant to all plans** so customers can call it
5. Optionally warm it from **Infrastructure** (`/admin/infra`), or leave `LLAMA_AUTO_LOAD=true` so the first API request loads it.

Registration writes a Postgres catalog row — dropping a file on disk alone is not enough.

```bash
# Inspect engine / registry / resident pool
pnpm engine:status

# Warm a registered model
pnpm engine:status your-model-slug
```

### Call the API

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer mf_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-slug",
    "messages": [{"role":"user","content":"Hello"}],
    "max_tokens": 256,
    "stream": false
  }'
```

Compatible with the official OpenAI SDKs — point `baseURL` at `http://localhost:3000/v1`.

### Reasoning models

Some models (e.g. Liquid AI LFM2.5) emit chain-of-thought in a separate `reasoning_content` field. ModelForge returns standard OpenAI `content` only. Use a generous `max_tokens` so the reasoning budget does not consume the whole limit. All generated tokens are billed.

## Inference backends

| `INFERENCE_BACKEND` | Compiler needed? | Notes |
|---|---|---|
| `llama-server` (default) | No | Prebuilt binaries; one loopback process per loaded model |
| `grpc` | Yes (MSVC/Clang + CMake) | Optional Rust engine with continuous batching |

Stay on `llama-server` unless you specifically need the Rust batching path.

```bash
# Optional Rust engine (INFERENCE_BACKEND=grpc)
# Windows: scripts/build-engine.cmd
# Then: cd apps/inference-engine && cargo run --release
```

## Configuration

Copy `.env.example` → `.env`. Important variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_ENABLED` | `false` skips Redis/BullMQ (in-memory limits + direct usage writes) |
| `MODEL_WEIGHTS_DIR` | Absolute path to GGUF storage |
| `INFERENCE_BACKEND` | `llama-server` or `grpc` |
| `LLAMA_SERVER_BIN` | Path to `llama-server` (filled by `pnpm llama:fetch`) |
| `LLAMA_AUTO_LOAD` | Warm models on first request (`true` recommended) |
| `TOTAL_RAM_BUDGET_MB` | Soft cap for resident models (LRU eviction) |
| `BILLING_MODE` | `mock` (default) or live Stripe / BD payment keys |
| `JWT_SECRET` / `AUTH_SECRET` / `INTERNAL_SERVICE_TOKEN` | Auth secrets — rotate for production |

## Billing

- **`BILLING_MODE=mock`** — local checkout without credentials
- **Stripe** — set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
- **bKash / Nagad** — Bangladesh invoice-first adapters (stubs ready for credentials)

API keys are stored as **SHA-256 hashes** only; the raw key is shown once at creation.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test

# OpenAI SDK smoke (gateway running)
MODELFORGE_API_KEY=mf_YOUR_KEY pnpm test:e2e
MODELFORGE_API_KEY=mf_YOUR_KEY pnpm benchmark

# llama-server integration (needs a GGUF under MODEL_WEIGHTS_DIR)
pnpm --filter @modelforge/gateway test
```

## Production notes

- Prefer physical core count for `DEFAULT_N_THREADS` / per-model `n_threads`
- Keep `MAX_CONCURRENT_PER_MODEL` low on CPU (1–2)
- Leave ~25–30% RAM headroom under `TOTAL_RAM_BUDGET_MB`
- Never expose inference ports publicly — only the gateway
- Example systemd units: `infra/systemd/`
- With Redis enabled, also run:
  - `pnpm --filter @modelforge/gateway worker`
  - `pnpm --filter @modelforge/gateway invoice-worker`

## Security

- Inference processes bind to **127.0.0.1** only
- Internal admin routes require `x-internal-token`
- Customer routes require hashed API keys or Auth.js sessions
- Admin UI is role-gated; customers never see ops controls

## Status

Early public release. Core local serving, metering, and dashboards work; payment adapters default to mock mode. Issues and PRs welcome.

## What is not in this repository

| Ignored | Why |
|---|---|
| `.env` | Secrets — copy from `.env.example` |
| `data/models/*.gguf` | Large model weights; place your own files here |
| `vendor/llama.cpp` | Fetched by `pnpm llama:fetch` |
| `node_modules/`, `.next/`, `dist/`, `target/` | Install / build outputs |

## License

Add a `LICENSE` file before publishing (e.g. MIT or Apache-2.0). Until then, all rights reserved by the authors.

---

Built for teams that need **on-prem / private-cloud LLM APIs** without shipping prompts or weights to a third-party host.
