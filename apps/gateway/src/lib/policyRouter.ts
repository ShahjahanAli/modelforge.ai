import { createHash } from "node:crypto";
import { prisma, type HostedModel } from "@modelforge/db";
import { evaluateRoutingPolicy, LocalPiiProvider } from "@modelforge/platform";

export interface AuthContext {
  customerId: string;
  apiKeyId: string;
  allowedModelIds: string[];
  planId?: string;
}

export interface ResolveModelResult {
  hosted: HostedModel;
  requestedModelSlug: string;
  resolvedModelSlug: string;
  reason: string;
  decisionHash: string;
  policyVersionId?: string;
  redactedMessages?: Array<{ role: string; content: string }>;
  piiFindings?: Array<{ ruleId: string; count: number }>;
}

function estimateCandidateCost(model: HostedModel, maxTokens: number): number {
  return Math.ceil(((512 + maxTokens) * (model.pricePerMTokIn + model.pricePerMTokOut)) / 100);
}

export async function resolveModelForRequest(input: {
  auth: AuthContext;
  requestedModel: string;
  maxTokens: number;
  messages?: Array<{ role: string; content: string }>;
  applyPii?: boolean;
}): Promise<ResolveModelResult> {
  const allowed = new Set(input.auth.allowedModelIds);
  const models = await prisma.hostedModel.findMany({
    where: {
      OR: [
        { modelId: { in: [...allowed] } },
        ...(input.requestedModel !== "auto" ? [{ modelId: input.requestedModel }] : []),
      ],
    },
  });
  const candidates = models
    .filter((model) => allowed.has(model.modelId) || input.requestedModel === model.modelId)
    .map((model) => ({
      modelSlug: model.modelId,
      costMicros: estimateCandidateCost(model, input.maxTokens),
      qualityClass: model.qualityClass,
      latencyClass: model.latencyClass,
      available: true,
    }));

  if (candidates.length === 0) {
    throw Object.assign(new Error(`Model ${input.requestedModel} not available on your plan`), {
      code: "MODEL_NOT_FOUND",
    });
  }

  const binding = await prisma.policyBinding.findFirst({
    where: {
      OR: [
        { apiKeyId: input.auth.apiKeyId },
        { customerId: input.auth.customerId },
        ...(input.auth.planId ? [{ planId: input.auth.planId }] : []),
        { policy: { scope: "PLATFORM", kind: "ROUTING" } },
      ],
      policy: { enabled: true, kind: "ROUTING" },
    },
    include: {
      policy: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } },
    },
    orderBy: { priority: "asc" },
  });

  const document =
    (binding?.policy.versions[0]?.document as {
      maxCostMicros?: number;
      minQuality?: number;
      maxLatencyClass?: number;
      preferredModels?: string[];
      fallbackModels?: string[];
    } | null) ?? {};

  const platformDefault = await prisma.hostedModel.findFirst({
    where: { isPlatformDefault: true },
    select: { modelId: true },
  });

  const decision = (() => {
    try {
      return evaluateRoutingPolicy(document, {
        requestedModel: input.requestedModel,
        candidates,
        platformDefaultModel: platformDefault?.modelId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Routing policy rejected request";
      throw Object.assign(new Error(message), { code: "ROUTING_POLICY_FAILED" });
    }
  })();

  if (input.requestedModel !== "auto" && !allowed.has(input.requestedModel)) {
    throw Object.assign(new Error(`Model ${input.requestedModel} not available on your plan`), {
      code: "MODEL_NOT_FOUND",
    });
  }
  if (!allowed.has(decision.resolvedModelSlug)) {
    throw Object.assign(new Error(`Resolved model ${decision.resolvedModelSlug} not entitled`), {
      code: "MODEL_NOT_FOUND",
    });
  }

  const hosted = models.find((model) => model.modelId === decision.resolvedModelSlug);
  if (!hosted) {
    throw Object.assign(new Error("Resolved model missing"), { code: "MODEL_NOT_FOUND" });
  }

  let redactedMessages = input.messages;
  let piiFindings: Array<{ ruleId: string; count: number }> | undefined;
  if (input.applyPii && input.messages) {
    const pii = new LocalPiiProvider();
    const findings = new Map<string, number>();
    redactedMessages = input.messages.map((message) => {
      const result = pii.redact(message.content);
      for (const finding of result.findings) {
        findings.set(finding.ruleId, (findings.get(finding.ruleId) ?? 0) + finding.count);
      }
      return { ...message, content: result.text };
    });
    piiFindings = [...findings.entries()].map(([ruleId, count]) => ({ ruleId, count }));
  }

  return {
    hosted,
    requestedModelSlug: input.requestedModel,
    resolvedModelSlug: decision.resolvedModelSlug,
    reason: decision.reason,
    decisionHash:
      decision.decisionHash ||
      createHash("sha256").update(`${input.requestedModel}:${decision.resolvedModelSlug}`).digest("hex"),
    policyVersionId: binding?.policy.versions[0]?.id,
    redactedMessages,
    piiFindings,
  };
}

/** Voice LLM analysis uses the platform default — not open-ended auto routing. */
export async function resolveVoiceAnalysisModel(input: {
  auth: AuthContext;
  requestedModel?: string;
}): Promise<string> {
  const requested = input.requestedModel?.trim();
  if (requested && requested !== "auto") {
    if (!input.auth.allowedModelIds.includes(requested)) {
      throw Object.assign(new Error(`Model ${requested} not available on your plan`), {
        code: "MODEL_NOT_FOUND",
      });
    }
    return requested;
  }

  const platformDefault = await prisma.hostedModel.findFirst({
    where: { isPlatformDefault: true },
    select: { modelId: true },
  });
  if (!platformDefault) {
    throw Object.assign(
      new Error("No platform default model configured — set one in Admin → Model Registry"),
      { code: "NO_DEFAULT_MODEL" },
    );
  }
  if (!input.auth.allowedModelIds.includes(platformDefault.modelId)) {
    throw Object.assign(
      new Error(`Platform default ${platformDefault.modelId} is not entitled on your plan`),
      { code: "MODEL_NOT_FOUND" },
    );
  }
  return platformDefault.modelId;
}
