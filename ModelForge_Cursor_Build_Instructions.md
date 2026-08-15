# ModelForge — Cursor Build Instructions

**Self-hosted LLM inference platform: model serving, API endpoint management, and subscription billing — fully owned, no third-party inference proxy (no vLLM/RunPod/OpenRouter dependency).**

**Deployment target: CPU-only inference.** This build uses llama.cpp specifically because it runs natively on CPU (no GPU required), with optional partial GPU offload later if hardware is added — but every default in this document assumes a CPU-only host.

Prepared for: ZMS Digital Solutions
Stack: pnpm monorepo · Next.js 16 · Express 5 · PostgreSQL/Prisma · Rust/Python inference sidecar (llama.cpp, CPU) · Redis/BullMQ

---

## 0. How to use this document in Cursor

Feed this file to Cursor as the project's `.cursorrules` context or paste section-by-section as prompts. Build in the phase order given in Section 9 — each phase is independently testable before moving to the next. Do not let Cursor generate the inference server and the billing system in the same session; keep them as separate conversations to avoid context bleed.

---

## 1. System Overview

ModelForge has three subsystems that must remain **decoupled** at the process level:

1. **Inference Engine** — owns system RAM, loads/unloads GGUF models, runs generation on CPU. Never talks to the internet, never knows about customers or billing.
2. **API Gateway** — the only public-facing HTTP surface. Owns auth, rate limiting, request normalization (OpenAI-compatible schema), usage metering. Talks to the Inference Engine over internal gRPC/HTTP, never exposes it directly.
3. **Control Plane** (admin + customer dashboards, billing, subscriptions) — Next.js app + Postgres. Reads usage data the Gateway writes; never sits in the hot request path.

```
                     ┌─────────────────────┐
   Customer apps ───▶│   API Gateway (5)    │───internal grpc───▶ Inference Engine (Rust/Py)
                     │  Express, auth, RL   │                     llama.cpp workers, model pool
                     └──────────┬───────────┘
                                │ writes usage events
                                ▼
                     ┌─────────────────────┐
                     │  PostgreSQL/Prisma   │◀── Control Plane (Next.js 16)
                     │  Redis (RL, cache)   │    admin + customer dashboard, billing
                     └─────────────────────┘
```

Why this separation matters: the inference process must be restart-safe and crash-isolated from the API layer. If a model OOMs or the llama.cpp worker segfaults, the Gateway should degrade gracefully (503 + retry-after), not crash itself.

---

## 2. Monorepo Structure

```
modelforge/
├── apps/
│   ├── web/                      # Next.js 16 — customer + admin dashboard
│   ├── gateway/                  # Express 5 — public API surface
│   └── inference-engine/         # Rust service wrapping llama.cpp
├── packages/
│   ├── engine/                   # shared: OpenAI-schema normalization, types
│   ├── db/                       # Prisma schema + generated client
│   ├── billing/                  # Stripe + bKash/Nagad adapters, usage→invoice logic
│   └── config/                   # shared eslint/tsconfig/tailwind config
├── infra/
│   ├── docker-compose.dev.yml
│   └── systemd/                  # unit files for bare-metal CPU server deployment
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
```

Use Turborepo for task orchestration (`turbo dev`, `turbo build`) since the inference-engine (Rust, `cargo build`) needs a different build pipeline than the TS packages — turbo lets you define per-package build commands cleanly.

---

## 3. Inference Engine (`apps/inference-engine`)

### 3.1 Why Rust + llama.cpp bindings, not a Python service
Reasoning to bake into Cursor's context: you want direct control over the serving loop (batching, KV cache management, model hot-swap) rather than a black-box runtime. Rust bindings to llama.cpp (`llama-cpp-2` crate) give you that control with production-grade memory safety, and avoid Python's GIL contention under concurrent request batching. If the team is more comfortable shipping Python first, use `llama-cpp-python` with a `multiprocessing`-based worker pool as a fallback — but plan the gRPC interface identically so you can swap the implementation later without touching the Gateway.

### 3.2 Cargo project setup
```bash
cd apps/inference-engine
cargo init --name inference_engine
cargo add tonic prost tokio --features tokio/full
cargo add llama-cpp-2
cargo add serde serde_json
cargo add tracing tracing-subscriber
```

### 3.3 gRPC service contract (`proto/inference.proto`)
```protobuf
syntax = "proto3";
package inference;

service InferenceEngine {
  rpc LoadModel (LoadModelRequest) returns (LoadModelResponse);
  rpc UnloadModel (UnloadModelRequest) returns (UnloadModelResponse);
  rpc ListLoadedModels (Empty) returns (ModelList);
  rpc Generate (GenerateRequest) returns (stream GenerateChunk);
  rpc HealthCheck (Empty) returns (HealthStatus);
}

message LoadModelRequest {
  string model_id = 1;
  string weights_path = 2;      // path to .gguf file
  int32 context_length = 3;
  int32 n_threads = 4;          // physical core count allocated to this model
  string quantization = 5;      // e.g. "Q4_K_M"
  bool use_mmap = 6;            // memory-map weights instead of full heap load
}

message LoadModelResponse {
  bool success = 1;
  string error = 2;
  int64 load_time_ms = 3;
  int64 ram_used_mb = 4;
}

message GenerateRequest {
  string model_id = 1;
  repeated ChatMessage messages = 2;
  float temperature = 3;
  int32 max_tokens = 4;
  float top_p = 5;
  repeated string stop_sequences = 6;
  bool stream = 7;
}

message ChatMessage {
  string role = 1;    // system | user | assistant
  string content = 2;
}

message GenerateChunk {
  string delta = 1;
  bool is_final = 2;
  int32 prompt_tokens = 3;
  int32 completion_tokens = 4;
  string finish_reason = 5;   // stop | length | error
}

message ModelList {
  repeated LoadedModel models = 1;
}

message LoadedModel {
  string model_id = 1;
  int64 ram_used_mb = 2;
  int64 loaded_at_unix = 3;
  int32 active_requests = 4;
  double tokens_per_sec_avg = 5;
}

message HealthStatus {
  bool healthy = 1;
  int64 total_ram_mb = 2;
  int64 used_ram_mb = 3;
  int32 loaded_model_count = 4;
  int32 physical_core_count = 5;
}

message LoadModelRequest_Empty {}
message Empty {}
message UnloadModelRequest { string model_id = 1; }
message UnloadModelResponse { bool success = 1; }
```

### 3.4 Model pool / hot-swap manager
This is the core differentiator. Build `src/model_pool.rs`:

- Maintain an `Arc<RwLock<HashMap<String, LoadedModel>>>` of currently resident models.
- Each `LoadedModel` wraps a `llama_cpp_2::LlamaModel` + `LlamaContext` plus a request semaphore capping concurrent generations per model (avoid KV-cache thrash — this matters more on CPU than GPU, see 3.5).
- **Eviction policy**: LRU by `last_used_at`, evict only when a new model load would exceed `TOTAL_RAM_BUDGET_MB` (read from env — this is system RAM, not VRAM, since there's no GPU). Never evict a model with `active_requests > 0`. Leave generous headroom (25–30% of physical RAM) since the OS, Postgres, Redis, and the Gateway process likely share the same box in a single-server deployment.
- **mmap the weight files.** Enable llama.cpp's `use_mmap` option (on by default in most bindings) so GGUF files are memory-mapped rather than fully copied into the process heap on load. This makes cold-starts and model-swaps significantly faster and lets the OS page cache do double duty across repeated loads of the same file — the single highest-leverage setting for a CPU multi-model host.
- Expose `ensure_loaded(model_id)` — called at the top of `Generate`; if not resident, load synchronously (accept the cold-start latency) and log it as a metric the Gateway can surface to customers ("cold start: 4.2s").
- **Weight-sharing for hot-swap speed**: if multiple hosted models share a base architecture/tokenizer (e.g. several fine-tunes of the same base), cache the shared layers separately and only swap the divergent weights on switch. Implement this as a stretch goal after the basic pool works — do not block Phase 1 on it.

### 3.5 Threading and batching (CPU-specific)
CPU inference does not parallelize across concurrent requests the way batched GPU inference does — compute, not just memory, is the bottleneck. Two knobs matter here, not one:

- **`n_threads` per model** — llama.cpp exposes this directly at context-creation time. Set it to the box's *physical* core count (not hyperthreads/logical cores; hyperthreading rarely helps llama.cpp's matmul-heavy workload and can hurt via cache contention). Make this a per-model config value, not global, so you can give a small model fewer threads and leave headroom for others running concurrently.
- **`max_concurrent_per_model` ceiling is low by default** — start at 1–2, not 4. Running two full generations on the same model at once on CPU means each gets roughly half the throughput; it's rarely worth the context-switch overhead until you've proven your hardware can sustain it.
- **Continuous batching still helps**, but the ceiling on CPU is fundamentally lower than GPU — a single tokio task per loaded model still pulls queued requests and steps the KV cache per-sequence, but plan customer-facing latency SLAs around CPU throughput, not GPU throughput. Start with a naive per-request thread and only move to continuous batching once correctness is proven (Phase 1 vs Phase 3, see Section 9).
- **Favor smaller/more aggressively quantized models for interactive use.** A 7B model at Q4_K_M is comfortably interactive on a modern multi-core CPU; anything past ~13B gets noticeably slow for chat-style latency unless the host has a high core count. Surface expected tokens/sec per model in the admin dashboard (Section 6.3) so this isn't a surprise at serving time.

### 3.6 Config (`inference-engine/config.toml`)
```toml
[server]
grpc_port = 50051
total_ram_budget_mb = 24000     # leave 25-30% of physical RAM as headroom
                                  # for OS, Postgres, Redis, and the Gateway process

[models]
weights_dir = "/data/models"     # local disk, GGUF files
use_mmap = true                  # memory-map weights instead of full heap load

[limits]
max_concurrent_per_model = 2     # CPU inference doesn't parallelize like GPU batching does
max_context_length = 32768
default_n_threads = 8            # set to physical core count of the host, not logical/hyperthreaded
```

---

## 4. API Gateway (`apps/gateway`)

### 4.1 Setup
```bash
cd apps/gateway
pnpm init
pnpm add express@5 zod ioredis bullmq @grpc/grpc-js @grpc/proto-loader jsonwebtoken
pnpm add -D typescript tsx @types/express
```

### 4.2 Route surface (OpenAI-compatible)
```
POST   /v1/chat/completions          # main inference endpoint, streaming + non-streaming
GET    /v1/models                    # list models this API key can access
GET    /v1/models/:modelId           # model metadata (context length, pricing tier)

# Management (customer dashboard calls these, authed via session not API key)
POST   /internal/keys                # issue new API key
DELETE /internal/keys/:id
GET    /internal/usage               # usage query for billing period
```

### 4.3 Request flow for `/v1/chat/completions`
1. `authMiddleware` — validate API key (hash lookup in Postgres via `packages/db`), attach `customerId`, `subscriptionTier`.
2. `rateLimitMiddleware` — Redis token bucket keyed by API key. Limits pulled from the customer's subscription tier (requests/min, tokens/day).
3. `quotaMiddleware` — check monthly token quota isn't exhausted (cached in Redis, reconciled against Postgres periodically via BullMQ job).
4. `normalizeRequest` — validate against `packages/engine` Zod schema (OpenAI chat-completions shape), reject malformed payloads before it ever reaches the inference engine.
5. Call `InferenceEngine.Generate` over gRPC. If streaming requested, pipe `GenerateChunk`s directly to an SSE response.
6. On completion, push a usage event to a BullMQ queue (`usage-events`) — **do not write to Postgres synchronously in the request path**; this queue is consumed by a worker that batches inserts.
7. Return OpenAI-shaped response (`choices[0].message`, `usage.prompt_tokens`, etc.) so existing OpenAI SDK clients work against your endpoint unmodified.

### 4.4 Usage event worker (`apps/gateway/src/workers/usage-worker.ts`)
```typescript
import { Worker } from "bullmq";
import { prisma } from "@modelforge/db";

new Worker("usage-events", async (job) => {
  const { customerId, apiKeyId, modelId, promptTokens, completionTokens, latencyMs } = job.data;
  await prisma.usageEvent.create({
    data: { customerId, apiKeyId, modelId, promptTokens, completionTokens, latencyMs, createdAt: new Date() },
  });
}, { connection: redisConnection, concurrency: 10 });
```

### 4.5 Error handling contract
The Gateway must translate inference-engine failures into clean HTTP semantics, never leak internal errors:
- Model not found → `404 { error: { type: "model_not_found" } }`
- Engine OOM / load failure → `503 { error: { type: "model_unavailable" }, retry_after: 30 }`
- Quota exceeded → `429 { error: { type: "quota_exceeded" } }`
- gRPC deadline exceeded (engine hung) → `504`

---

## 5. Database Schema (`packages/db/prisma/schema.prisma`)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Customer {
  id            String         @id @default(cuid())
  email         String         @unique
  name          String?
  createdAt     DateTime       @default(now())
  subscription  Subscription?
  apiKeys       ApiKey[]
  usageEvents   UsageEvent[]
  invoices      Invoice[]
}

model Plan {
  id                String   @id @default(cuid())
  name              String   @unique      // "free" | "pro" | "enterprise"
  monthlyTokenQuota BigInt
  requestsPerMinute Int
  maxConcurrent     Int
  priceCentsMonthly Int
  allowedModelIds   String[]              // which hosted models this plan can call
  subscriptions     Subscription[]
}

model Subscription {
  id           String   @id @default(cuid())
  customer     Customer @relation(fields: [customerId], references: [id])
  customerId   String   @unique
  plan         Plan     @relation(fields: [planId], references: [id])
  planId       String
  status       String   // active | past_due | canceled
  stripeSubId  String?
  currentPeriodEnd DateTime
  createdAt    DateTime @default(now())
}

model ApiKey {
  id          String       @id @default(cuid())
  customer    Customer     @relation(fields: [customerId], references: [id])
  customerId  String
  keyHash     String       @unique   // sha256, never store raw key
  keyPrefix   String                 // first 8 chars, shown in dashboard for identification
  label       String?
  revokedAt   DateTime?
  createdAt   DateTime     @default(now())
  usageEvents UsageEvent[]
}

model HostedModel {
  id              String   @id @default(cuid())
  modelId         String   @unique   // slug used in API, e.g. "zms-coder-7b"
  displayName     String
  weightsPath     String              // path on the inference box
  quantization    String
  contextLength   Int
  gpuLayers       Int
  status          String   @default("inactive") // inactive | loaded | error
  pricePerMTokIn  Int                 // price in cents per million input tokens
  pricePerMTokOut Int
  createdAt       DateTime @default(now())
  usageEvents     UsageEvent[]
}

model UsageEvent {
  id               String      @id @default(cuid())
  customer         Customer    @relation(fields: [customerId], references: [id])
  customerId       String
  apiKey           ApiKey      @relation(fields: [apiKeyId], references: [id])
  apiKeyId         String
  model            HostedModel @relation(fields: [modelId], references: [id])
  modelId          String
  promptTokens     Int
  completionTokens Int
  latencyMs        Int
  createdAt        DateTime    @default(now())

  @@index([customerId, createdAt])
  @@index([modelId, createdAt])
}

model Invoice {
  id            String   @id @default(cuid())
  customer      Customer @relation(fields: [customerId], references: [id])
  customerId    String
  periodStart   DateTime
  periodEnd     DateTime
  amountCents   Int
  status        String   // draft | sent | paid | overdue
  stripeInvoiceId String?
  createdAt     DateTime @default(now())
}
```

Run:
```bash
pnpm --filter @modelforge/db exec prisma migrate dev --name init
```

---

## 6. Control Plane / Dashboard (`apps/web`, Next.js 16)

### 6.1 Setup
```bash
cd apps/web
pnpm create next-app@latest . --typescript --tailwind --app
pnpm add @modelforge/db @modelforge/billing recharts lucide-react
```

### 6.2 Route structure
```
app/
├── (customer)/
│   ├── dashboard/page.tsx           # usage graphs, current spend
│   ├── keys/page.tsx                # create/revoke API keys
│   ├── billing/page.tsx             # plan, invoices, upgrade
│   └── models/page.tsx              # browse available models + pricing
├── (admin)/
│   ├── admin/models/page.tsx        # upload GGUF, configure n_threads/quant, load/unload
│   ├── admin/customers/page.tsx     # all customers, override quotas
│   ├── admin/infra/page.tsx         # live RAM usage, loaded models, health
│   └── admin/revenue/page.tsx       # MRR, cost-to-serve per model, margin
└── api/
    └── webhooks/stripe/route.ts     # subscription lifecycle events
```

### 6.3 Admin infra page — critical for you operationally
This page calls the inference-engine's `HealthCheck` and `ListLoadedModels` RPCs (proxied through a thin internal Gateway route, never called directly from the browser). Show:
- RAM used / total, per-model breakdown, physical core count and per-model thread allocation
- Measured tokens/sec per loaded model (from `tokens_per_sec_avg`) — this is the number that tells you and your customers what "interactive" actually means for that model on your hardware
- Load/unload buttons per model (calls `LoadModel`/`UnloadModel`)
- Cost-to-serve: `(server-hour cost / requests served that hour)` vs `revenue from those requests` — this is the number that tells you if a model is profitable to keep hot. On a CPU box this cost is much flatter than GPU-hour pricing, but it's still worth tracking per model since larger models eat more of your fixed core budget.

### 6.4 Model upload flow (admin)
1. Admin uploads `.gguf` file → stored in S3-compatible object storage (or local disk if single-box deployment).
2. Admin sets `quantization`, `context_length`, `n_threads`, pricing per million tokens. Surface a rough size/speed guide in the UI (e.g. "7B Q4_K_M: fast, interactive · 13B Q4_K_M: moderate · 30B+: batch/async use only") so admins don't over-promise latency on models too large for CPU.
3. `HostedModel` row created with `status: "inactive"`.
4. Admin clicks "Activate" → Gateway calls `LoadModel` RPC → on success, `status: "loaded"`, model becomes callable via `/v1/chat/completions`.

---

## 7. Billing (`packages/billing`)

### 7.1 Two billing modes to support
- **Subscription tier** (simplest): flat monthly fee, token quota, overage blocked or billed at a per-token overage rate.
- **Pure usage-based** (for enterprise): no quota, bill actual `(promptTokens × pricePerMTokIn + completionTokens × pricePerMTokOut) / 1,000,000` monthly via Stripe metered billing.

### 7.2 Monthly invoice job (BullMQ repeatable job, runs daily, generates on period end)
```typescript
export async function generateInvoice(customerId: string, periodStart: Date, periodEnd: Date) {
  const events = await prisma.usageEvent.findMany({
    where: { customerId, createdAt: { gte: periodStart, lt: periodEnd } },
    include: { model: true },
  });

  const amountCents = events.reduce((sum, e) => {
    const inCost = (e.promptTokens / 1_000_000) * e.model.pricePerMTokIn;
    const outCost = (e.completionTokens / 1_000_000) * e.model.pricePerMTokOut;
    return sum + inCost + outCost;
  }, 0);

  return prisma.invoice.create({
    data: { customerId, periodStart, periodEnd, amountCents: Math.round(amountCents), status: "draft" },
  });
}
```

### 7.3 Payment adapters
- **Stripe** (`packages/billing/stripe.ts`) — subscriptions, metered usage records, webhook handling for `invoice.paid`, `customer.subscription.deleted`.
- **bKash/Nagad** (`packages/billing/bd-payments.ts`) — for Bangladesh-market customers; these don't support metered billing natively, so generate the invoice via the job above and create a payment request/checkout link manually.

---

## 8. Environment Variables

```bash
# .env (root)
DATABASE_URL=postgresql://user:pass@localhost:5432/modelforge
REDIS_URL=redis://localhost:6379

# gateway
INFERENCE_ENGINE_GRPC_URL=localhost:50051
JWT_SECRET=

# billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
BKASH_APP_KEY=
BKASH_APP_SECRET=

# inference-engine (config.toml preferred, env override supported)
TOTAL_RAM_BUDGET_MB=24000
MODEL_WEIGHTS_DIR=/data/models
DEFAULT_N_THREADS=8
USE_MMAP=true
```

---

## 9. Build Phases (do these in order, separate Cursor sessions)

**Phase 1 — Inference engine, naive single-request path**
Get one GGUF model loading and generating via a bare gRPC call, no batching, no pool eviction. Prove `Generate` streams tokens correctly. Test with `grpcurl`.

**Phase 2 — Gateway wraps it, no auth yet**
Express route calls the gRPC service, returns OpenAI-shaped JSON. Test with the official OpenAI Node SDK pointed at `http://localhost:3000/v1` to confirm compatibility.

**Phase 3 — Model pool + hot-swap**
Add the eviction/LRU logic, RAM budget tracking, mmap, multi-model residency. Load two models, alternate requests, confirm no OOM and confirm mmap actually reduces reload latency (measure it).

**Phase 4 — Auth, rate limiting, quotas**
API keys, Redis token bucket, Postgres-backed quota checks.

**Phase 5 — Usage metering + billing**
BullMQ usage worker, Prisma writes, invoice generation job, Stripe webhook wiring.

**Phase 6 — Dashboards**
Customer dashboard (keys, usage graphs, billing) then admin dashboard (infra health, model management, revenue).

**Phase 7 — Continuous batching (perf work)**
Only after correctness is proven end-to-end. This is where you get real throughput gains.

---

## 10. Operational Notes Specific to Your Setup

- **CPU-only means standard bare-metal/VPS hosting works** — no GPU rental, no CUDA driver management, no RunPod dependency. Any box with enough RAM and physical cores (a dedicated server or a large cloud VM) is sufficient. This meaningfully simplifies ops versus a GPU deployment, but also means the crash-isolation design (Section 1) still matters, since there's no orchestrator like Kubernetes auto-restarting pods unless you add one. Consider a `systemd` unit with `Restart=on-failure` for the inference-engine binary as the simplest reliability layer for a single-box deployment (see `infra/systemd/`).
- **Right-size customer expectations to CPU throughput.** Because concurrency-per-model is low (Section 3.5), be explicit in plan tiers about tokens/sec and concurrent-request limits rather than implying GPU-class throughput. This also affects billing design — consider pricing partly on guaranteed concurrency slots, not just token volume, since that's your actual scarce resource on CPU.
- **Model catalog should skew toward smaller, well-quantized models** (3B–13B range at Q4_K_M or similar) as your primary hosted lineup; treat anything larger as a special/enterprise-tier offering with clear async or batch-oriented latency expectations rather than promising chat-speed responses.
- Your Synaptic Drift weight-fragmentation research is the natural Phase 3+ upgrade path — the model pool's hot-swap mechanism (now mmap-backed) is exactly the productization surface for that work, and matters even more on CPU where reload latency is a bigger fraction of total request time than on GPU. Don't build it into v1; get the naive pool working first.
- For Bangladesh/government clients (Center of All angle), the data-residency story is: model weights and all inference happen in this stack, never sent to a third-party API — worth a dedicated "Compliance" page in the admin dashboard once the core platform is stable. CPU-only hosting also lowers the hardware procurement bar for on-premise government deployments, which may strengthen that pitch.
