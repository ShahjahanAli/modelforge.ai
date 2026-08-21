export type MeterKind = "llm" | "stt" | "neo4j_read" | "neo4j_write" | "neo4j_storage";

export function classifyUsageSlug(modelSlug: string): MeterKind {
  if (modelSlug.startsWith("stt:")) return "stt";
  if (modelSlug === "neo4j:read") return "neo4j_read";
  if (modelSlug === "neo4j:write") return "neo4j_write";
  if (modelSlug === "neo4j:storage") return "neo4j_storage";
  return "llm";
}

/** Default STT billable units per audio second (gateway may override via env). */
export const DEFAULT_STT_BILLABLE_UNITS_PER_SEC = 25;

/** Plan quota 0 = unlimited. Otherwise stack admin bonus on the plan allotment. */
export function effectiveMonthlyQuota(planQuota: bigint, bonusTokens: bigint = 0n): bigint {
  if (planQuota <= 0n) return 0n;
  const bonus = bonusTokens > 0n ? bonusTokens : 0n;
  return planQuota + bonus;
}

export function summarizeUsageEvents(
  events: Array<{ modelSlug: string; promptTokens: number; completionTokens: number }>,
  sttUnitsPerSec = DEFAULT_STT_BILLABLE_UNITS_PER_SEC,
) {
  let llmPrompt = 0;
  let llmCompletion = 0;
  let sttBillable = 0;
  let neo4jReads = 0;
  let neo4jWrites = 0;
  let neo4jStoreBytes = 0;

  for (const event of events) {
    switch (classifyUsageSlug(event.modelSlug)) {
      case "stt":
        sttBillable += event.promptTokens;
        break;
      case "neo4j_read":
        neo4jReads += Math.max(1, event.promptTokens);
        break;
      case "neo4j_write":
        neo4jWrites += Math.max(1, event.promptTokens);
        break;
      case "neo4j_storage":
        neo4jStoreBytes = Math.max(neo4jStoreBytes, event.promptTokens);
        break;
      default:
        llmPrompt += event.promptTokens;
        llmCompletion += event.completionTokens;
        break;
    }
  }

  return {
    llmPrompt,
    llmCompletion,
    llmTotal: llmPrompt + llmCompletion,
    sttSeconds: sttBillable / Math.max(1, sttUnitsPerSec),
    sttBillable,
    neo4jReads,
    neo4jWrites,
    neo4jStoreBytes,
  };
}
