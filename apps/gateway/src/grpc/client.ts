import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GenerateChunk {
  delta: string;
  is_final: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  finish_reason: string;
}

export interface LoadedModel {
  model_id: string;
  ram_used_mb: number;
  loaded_at_unix: number;
  active_requests: number;
  tokens_per_sec_avg: number;
}

export interface HealthStatus {
  healthy: boolean;
  total_ram_mb: number;
  used_ram_mb: number;
  loaded_model_count: number;
  physical_core_count: number;
}

type Client = {
  LoadModel: (
    req: Record<string, unknown>,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  UnloadModel: (
    req: Record<string, unknown>,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  ListLoadedModels: (
    req: Record<string, unknown>,
    cb: (err: grpc.ServiceError | null, res: { models: LoadedModel[] }) => void,
  ) => void;
  HealthCheck: (
    req: Record<string, unknown>,
    cb: (err: grpc.ServiceError | null, res: HealthStatus) => void,
  ) => void;
  Generate: (
    req: Record<string, unknown>,
    options?: grpc.CallOptions,
  ) => grpc.ClientReadableStream<GenerateChunk>;
};

let client: Client | null = null;

function protoPath(): string {
  return path.resolve(
    __dirname,
    "../../../../apps/inference-engine/proto/inference.proto",
  );
}

export function getInferenceClient(url = process.env.INFERENCE_ENGINE_GRPC_URL ?? "localhost:50051") {
  if (client) return client;
  const packageDef = protoLoader.loadSync(protoPath(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef) as unknown as {
    inference: { InferenceEngine: new (addr: string, creds: grpc.ChannelCredentials) => Client };
  };
  client = new proto.inference.InferenceEngine(url, grpc.credentials.createInsecure());
  return client;
}

export function generateStream(
  req: {
    model_id: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    max_tokens: number;
    top_p: number;
    stop_sequences: string[];
    stream: boolean;
  },
  url?: string,
  options?: { signal?: AbortSignal; deadlineMs?: number },
): AsyncIterable<GenerateChunk> {
  const c = getInferenceClient(url);
  const call = c.Generate(req, {
    deadline: new Date(Date.now() + (options?.deadlineMs ?? 300_000)),
  });
  const abort = () => call.cancel();
  options?.signal?.addEventListener("abort", abort, { once: true });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of call as unknown as AsyncIterable<GenerateChunk>) {
          yield chunk;
        }
      } finally {
        options?.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

function promisify<T>(
  fn: (req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: T) => void) => void,
  req: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

export async function loadModel(req: {
  model_id: string;
  weights_path: string;
  context_length: number;
  n_threads: number;
  quantization: string;
  use_mmap: boolean;
}) {
  return promisify(getInferenceClient().LoadModel.bind(getInferenceClient()), req);
}

export async function unloadModel(model_id: string) {
  return promisify(getInferenceClient().UnloadModel.bind(getInferenceClient()), { model_id });
}

export async function listLoadedModels() {
  return promisify(getInferenceClient().ListLoadedModels.bind(getInferenceClient()), {});
}

export async function healthCheck() {
  return promisify(getInferenceClient().HealthCheck.bind(getInferenceClient()), {});
}

export function mapGrpcError(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as grpc.ServiceError;
    const details = e.details || e.message || "engine error";
    if (e.code === grpc.status.NOT_FOUND) return { code: "MODEL_NOT_FOUND", message: details };
    if (e.code === grpc.status.UNAVAILABLE) return { code: "MODEL_UNAVAILABLE", message: details };
    if (e.code === grpc.status.DEADLINE_EXCEEDED)
      return { code: "DEADLINE_EXCEEDED", message: details };
    if (e.code === grpc.status.INVALID_ARGUMENT)
      return { code: "INVALID_ARGUMENT", message: details };
    if (details.includes("OOM")) return { code: "OOM", message: details };
  }
  return { code: "INTERNAL", message: err instanceof Error ? err.message : "unknown" };
}
