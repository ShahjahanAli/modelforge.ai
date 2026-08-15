import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { loadEnv } from "./lib/env.js";
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
  console.error(err);
  res.status(500).json({ error: { type: "server_error", message: "Internal error" } });
});

const server = app.listen(env.GATEWAY_PORT, () => {
  console.log(`ModelForge gateway listening on :${env.GATEWAY_PORT}`);
  console.log(
    env.REDIS_ENABLED
      ? "Redis enabled (BullMQ usage workers expected)"
      : "Redis disabled (in-memory rate limits + direct Postgres usage writes)",
  );
});

function shutdown() {
  console.log("Shutting down gateway...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
