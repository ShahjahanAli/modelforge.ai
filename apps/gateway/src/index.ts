import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { loadEnv } from "./lib/env.js";
import { ensureLocalNode } from "./lib/modernJobs.js";
import { ensureSigningKey } from "./lib/receipts.js";
import { hydrateArmedCoreTraces } from "./lib/coreTrace.js";
import { restoreHuggingFaceDownloads } from "./lib/huggingFace.js";
import { reconcileModelRegistry, shutdownEngine } from "./engine/index.js";
import { closeNeo4j } from "./lib/neo4j.js";
import { internalRouter } from "./routes/internal.js";
import { v1Router } from "./routes/v1.js";

const env = loadEnv();
const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
  }),
);
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  req.requestId = req.header("x-request-id") ?? randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "gateway" });
});

app.use("/v1", v1Router);
app.use("/internal", internalRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const anyErr = err as { type?: string; status?: number; message?: string; limit?: number };
  if (anyErr?.type === "entity.too.large" || anyErr?.status === 413) {
    const limitMb = anyErr.limit ? Math.round(anyErr.limit / (1024 * 1024)) : undefined;
    return res.status(413).json({
      error: {
        type: "payload_too_large",
        message: limitMb
          ? `Request body exceeds ${limitMb}MB (raise VOICE_MAX_UPLOAD_MB and retry)`
          : "Request body too large",
      },
    });
  }
  console.error(err);
  res.status(500).json({ error: { type: "server_error", message: "Internal error" } });
});

const server = app.listen(env.GATEWAY_PORT, async () => {
  console.log(`ModelForge gateway listening on :${env.GATEWAY_PORT}`);
  console.log(
    env.REDIS_ENABLED
      ? "Redis enabled (BullMQ usage workers expected)"
      : "Redis disabled (in-memory rate limits + direct Postgres usage writes)",
  );
  try {
    const resumedDownloads = await restoreHuggingFaceDownloads();
    await reconcileModelRegistry();
    await ensureLocalNode();
    await ensureSigningKey();
    const armedTraces = await hydrateArmedCoreTraces();
    console.log(
      `Local node + signing key ready (${armedTraces} diagnostic trace(s) armed${
        resumedDownloads ? `, ${resumedDownloads} Hub download(s) resumed` : ""
      })`,
    );
  } catch (error) {
    console.warn("Modern platform bootstrap deferred:", error);
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down gateway...");
  await shutdownEngine().catch((error: unknown) => {
    console.warn("Engine shutdown was incomplete:", error);
  });
  await closeNeo4j().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
