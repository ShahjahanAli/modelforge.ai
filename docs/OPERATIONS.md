# Operations

## Migrations

```bash
pnpm db:generate
pnpm --filter @modelforge/db exec prisma migrate deploy
pnpm db:seed
```

## Model installation

1. Copy `.gguf` into `MODEL_WEIGHTS_DIR` (default `./data/models`).
2. Register in Admin → Models (`weightsPath` = filename only).
3. Activate via Admin → Infra → Load (calls Gateway → `LoadModel` RPC).

## Secrets

Never commit `.env`. Rotate `JWT_SECRET`, `AUTH_SECRET`, `INTERNAL_SERVICE_TOKEN` in production.

## Backups

- PostgreSQL: `pg_dump` daily
- Redis: AOF enabled in compose; treat as ephemeral for rate limits/quota cache
- Model weights: versioned object storage or offline media

## Workers

- `pnpm --filter @modelforge/gateway worker` — usage event inserts
- `pnpm --filter @modelforge/gateway invoice-worker` — daily period-end invoices

## CPU tuning

| Knob | Guidance |
|---|---|
| `DEFAULT_N_THREADS` | Physical cores, not hyperthreads |
| `MAX_CONCURRENT_PER_MODEL` | Start at 1–2 |
| `TOTAL_RAM_BUDGET_MB` | ≤ 70–75% of physical RAM |
| Quantization | Q4_K_M for interactive 7B |

## Rollback

1. Stop gateway/web
2. `prisma migrate resolve` / redeploy previous migration if needed
3. Restart inference binary from previous release artifact
4. Confirm `/healthz` and engine `HealthCheck`
