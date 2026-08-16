import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    ),
  ]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
});

export const toolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

export const modelforgeControlsSchema = z
  .object({
    budget_micros: z.number().int().nonnegative().optional(),
    max_latency_ms: z.number().int().positive().optional(),
    min_quality: z.number().int().min(0).max(100).optional(),
    prefer_local: z.boolean().optional(),
    knowledge_base_ids: z.array(z.string()).optional(),
    hedge: z.boolean().optional(),
  })
  .optional();

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  top_p: z.number().min(0).max(1).optional().default(1),
  max_tokens: z.number().int().positive().max(32768).optional().default(4096),
  stream: z.boolean().optional().default(false),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return [] as string[];
      return Array.isArray(v) ? v : [v];
    }),
  user: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: z
    .union([
      z.enum(["none", "auto", "required"]),
      z.object({
        type: z.literal("function"),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object"]),
    })
    .optional(),
  metadata: z
    .object({
      modelforge: modelforgeControlsSchema,
    })
    .passthrough()
    .optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export function normalizeMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string }> {
  return messages.map((m) => {
    const content =
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((part) => part.text ?? "")
            .filter(Boolean)
            .join("\n");
    return { role: m.role, content };
  });
}
