/**
 * OpenAI-compatible remote LLM client (OpenRouter, Gemini, OpenAI, Azure proxies, etc.).
 */
import { prisma } from "@modelforge/db";
import { decryptProviderSecret } from "../lib/providerCredentials.js";
import type { GenerateChunk } from "../grpc/client.js";

/** Google Gemini OpenAI-compatible chat completions base. */
export const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";

class RemoteEngineError extends Error {
  constructor(
    message: string,
    public readonly code = "REMOTE_PROVIDER_ERROR",
  ) {
    super(message);
    this.name = "RemoteEngineError";
  }
}

interface UpstreamPart {
  content?: string | null;
  reasoning_content?: string | null;
}

interface UpstreamChoice {
  delta?: UpstreamPart;
  message?: UpstreamPart;
  finish_reason?: string | null;
}

interface UpstreamResponse {
  choices?: UpstreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function hasJsonObject(text: string): boolean {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start;
}

/**
 * Reasoning models (Qwen3 via OpenRouter) often put the real answer in
 * `reasoning_content` while `content` is a short stub / empty JSON skeleton.
 * Prefer the field that actually carries usable text (JSON object when requested).
 */
function resolveAssistantText(
  part: UpstreamPart | undefined,
  opts?: { jsonMode?: boolean },
): string {
  const content = part?.content ?? "";
  const reasoning = part?.reasoning_content ?? "";
  if (opts?.jsonMode) {
    if (hasJsonObject(content)) return content;
    if (hasJsonObject(reasoning)) return reasoning;
    return content.length ? content : reasoning;
  }
  if (!content.trim()) return reasoning;
  // Stub final answer while the long cleaned transcript sits in reasoning.
  if (
    reasoning.trim().length > 80 &&
    content.trim().length < 48 &&
    reasoning.length > content.length * 2
  ) {
    return reasoning;
  }
  return content;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

function isOpenRouterBase(url: string): boolean {
  return /openrouter\.ai/i.test(url);
}

function isGeminiBase(url: string): boolean {
  return /generativelanguage\.googleapis\.com/i.test(url);
}

function resolveEnvApiKey(base: string): string {
  const openRouter = process.env.OPENROUTER_API_KEY?.trim() || "";
  const gemini = process.env.GEMINI_API_KEY?.trim() || "";
  const generic = process.env.REMOTE_LLM_API_KEY?.trim() || "";
  if (isGeminiBase(base)) return gemini || generic;
  if (isOpenRouterBase(base)) return openRouter || generic;
  return openRouter || gemini || generic;
}

async function resolveRemoteEndpoint(modelId: string): Promise<{
  url: string;
  apiKey: string;
  upstreamModel: string;
  headers: Record<string, string>;
  openRouter: boolean;
}> {
  const hosted = await prisma.hostedModel.findUnique({
    where: { modelId },
    include: { credential: true },
  });
  if (!hosted || hosted.providerKind !== "OPENAI_COMPAT") {
    throw new RemoteEngineError(`Model ${modelId} is not an OpenAI-compatible remote provider`);
  }
  const base =
    hosted.remoteBaseUrl?.trim() ||
    process.env.GEMINI_BASE_URL?.trim() ||
    process.env.OPENROUTER_BASE_URL?.trim() ||
    process.env.REMOTE_LLM_BASE_URL?.trim() ||
    "https://openrouter.ai/api/v1";
  const upstreamModel = (hosted.remoteModelId?.trim() || hosted.modelId).trim();
  if (!upstreamModel) {
    throw new RemoteEngineError(`Remote model id missing for ${modelId}`);
  }

  let apiKey = "";
  if (hosted.credential) {
    apiKey = decryptProviderSecret(hosted.credential);
  } else {
    apiKey = resolveEnvApiKey(base);
  }
  if (!apiKey) {
    throw new RemoteEngineError(
      `No API key configured for remote model ${modelId} (assign a ProviderCredential or set GEMINI_API_KEY / OPENROUTER_API_KEY)`,
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter optional attribution headers (harmless for other providers).
  if (isOpenRouterBase(base)) {
    if (process.env.OPENROUTER_HTTP_REFERER) {
      headers["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER;
    }
    if (process.env.OPENROUTER_APP_TITLE) {
      headers["X-Title"] = process.env.OPENROUTER_APP_TITLE;
    }
  }

  return {
    url: `${normalizeBaseUrl(base)}/chat/completions`,
    apiKey,
    upstreamModel,
    headers,
    openRouter: isOpenRouterBase(base),
  };
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
    response_format?: { type: "text" | "json_object" };
  },
  _url?: string,
  options?: { signal?: AbortSignal; deadlineMs?: number },
): AsyncIterable<GenerateChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      const endpoint = await resolveRemoteEndpoint(req.model_id);
      const timeout = AbortSignal.timeout(options?.deadlineMs ?? 300_000);
      const signal = options?.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      const jsonMode = req.response_format?.type === "json_object";

      // Disable thinking for structured / cleanup jobs. Qwen3 otherwise burns
      // the budget in reasoning and returns a tiny stub in `content` (matches
      // OpenRouter activity showing 12–20 completion tokens).
      const disableReasoning =
        process.env.REMOTE_LLM_DISABLE_REASONING !== "0" &&
        (endpoint.openRouter || process.env.REMOTE_LLM_DISABLE_REASONING === "1");

      const payload: Record<string, unknown> = {
        model: endpoint.upstreamModel,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        top_p: req.top_p,
        ...(req.stop_sequences.length > 0 ? { stop: req.stop_sequences } : {}),
        stream: req.stream,
        ...(req.stream ? { stream_options: { include_usage: true } } : {}),
        ...(req.response_format ? { response_format: req.response_format } : {}),
        ...(disableReasoning
          ? { reasoning: { effort: "none", exclude: true } }
          : {}),
      };

      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
        body: JSON.stringify(payload),
        signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new RemoteEngineError(`Remote LLM ${res.status}: ${body.slice(0, 800)}`);
      }

      let promptTokens = 0;
      let completionTokens = 0;

      if (!req.stream) {
        const body = (await res.json()) as UpstreamResponse;
        promptTokens = body.usage?.prompt_tokens ?? 0;
        completionTokens = body.usage?.completion_tokens ?? 0;
        const message = body.choices?.[0]?.message;
        const contentLen = (message?.content ?? "").length;
        const reasoningLen = (message?.reasoning_content ?? "").length;
        if (reasoningLen > 0 || contentLen < 64) {
          console.info(
            JSON.stringify({
              event: "remote.openai.message_shape",
              model: endpoint.upstreamModel,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              content_chars: contentLen,
              reasoning_chars: reasoningLen,
              json_mode: jsonMode,
              finish_reason: body.choices?.[0]?.finish_reason ?? null,
            }),
          );
        }
        yield {
          delta: resolveAssistantText(message, { jsonMode }),
          is_final: true,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          finish_reason: body.choices?.[0]?.finish_reason ?? "stop",
        };
        return;
      }

      if (!res.body) throw new RemoteEngineError("Remote LLM returned no body");

      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason = "stop";
      let contentAcc = "";
      let reasoningAcc = "";

      for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          let parsed: UpstreamResponse;
          try {
            parsed = JSON.parse(data) as UpstreamResponse;
          } catch {
            continue;
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
            completionTokens = parsed.usage.completion_tokens ?? completionTokens;
          }
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (choice?.delta?.content) contentAcc += choice.delta.content;
          if (choice?.delta?.reasoning_content) {
            reasoningAcc += choice.delta.reasoning_content;
          }
        }
      }

      const assembled = resolveAssistantText(
        { content: contentAcc, reasoning_content: reasoningAcc },
        { jsonMode },
      );
      if (assembled) {
        yield {
          delta: assembled,
          is_final: false,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          finish_reason: "",
        };
      }

      yield {
        delta: "",
        is_final: true,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        finish_reason: finishReason,
      };
    },
  };
}

export function mapRemoteError(err: unknown): { code: string; message: string } {
  if (err instanceof RemoteEngineError) {
    return { code: err.code, message: err.message };
  }
  return {
    code: "REMOTE_PROVIDER_ERROR",
    message: err instanceof Error ? err.message : "Remote LLM failed",
  };
}
