export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "error" | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | "length" | "error" | null;
  }>;
  usage?: Usage;
}

export function buildCompletionResponse(input: {
  id: string;
  model: string;
  content: string;
  finishReason: "stop" | "length" | "error";
  promptTokens: number;
  completionTokens: number;
}): ChatCompletionResponse {
  return {
    id: input.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.content },
        finish_reason: input.finishReason,
      },
    ],
    usage: {
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
      total_tokens: input.promptTokens + input.completionTokens,
    },
  };
}

export function buildChunk(input: {
  id: string;
  model: string;
  delta?: string;
  role?: boolean;
  finishReason?: "stop" | "length" | "error" | null;
  usage?: Usage;
}): ChatCompletionChunk {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        delta: {
          ...(input.role ? { role: "assistant" as const } : {}),
          ...(input.delta !== undefined ? { content: input.delta } : {}),
        },
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

export function toSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
