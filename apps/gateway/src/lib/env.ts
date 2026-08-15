import { z } from "zod";

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return true;
    if (typeof v === "boolean") return v;
    return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
  });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_ENABLED: boolish,
  REDIS_URL: z.string().default("redis://localhost:6379"),
  GATEWAY_PORT: z.coerce.number().default(3000),
  INFERENCE_ENGINE_GRPC_URL: z.string().default("localhost:50051"),
  JWT_SECRET: z.string().min(8),
  INTERNAL_SERVICE_TOKEN: z.string().min(8),
  CORS_ORIGIN: z.string().default("http://localhost:3001"),
  MODEL_WEIGHTS_DIR: z.string().default("./data/models"),
  INFERENCE_BACKEND: z.enum(["llama-server", "grpc"]).default("llama-server"),
  LLAMA_SERVER_BIN: z.string().optional(),
  LLAMA_SERVER_PORT_BASE: z.coerce.number().default(8100),
  TOTAL_RAM_BUDGET_MB: z.coerce.number().default(24000),
});

export type GatewayEnv = z.infer<typeof envSchema>;

export function loadEnv(): GatewayEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid gateway environment");
  }
  return parsed.data;
}
