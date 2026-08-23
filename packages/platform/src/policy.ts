import { z } from "zod";
import { hashCanonicalPayload } from "./canonical.js";

export const routingPolicyDocumentSchema = z.object({
  maxCostMicros: z.number().int().nonnegative().optional(),
  minQuality: z.number().finite().optional(),
  maxLatencyClass: z.number().finite().optional(),
  preferredModels: z.array(z.string().min(1)).default([]),
  fallbackModels: z.array(z.string().min(1)).default([]),
});

export const routingCandidateSchema = z.object({
  modelSlug: z.string().min(1),
  costMicros: z.number().int().nonnegative(),
  qualityClass: z.number().finite(),
  latencyClass: z.number().finite(),
  available: z.boolean().default(true),
});

export const routingContextSchema = z.object({
  requestedModel: z.string().min(1),
  candidates: z.array(routingCandidateSchema).min(1),
  platformDefaultModel: z.string().min(1).optional(),
});

export type RoutingPolicyDocument = z.input<typeof routingPolicyDocumentSchema>;
export type RoutingCandidate = z.input<typeof routingCandidateSchema>;
export type RoutingContext = z.input<typeof routingContextSchema>;

export interface RoutingDecision {
  resolvedModelSlug: string;
  reason: string;
  decisionHash: string;
}

function firstListedCandidate(
  slugs: string[],
  candidates: z.output<typeof routingCandidateSchema>[],
): z.output<typeof routingCandidateSchema> | undefined {
  for (const slug of slugs) {
    const match = candidates.find((candidate) => candidate.modelSlug === slug);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function evaluateRoutingPolicy(
  document: RoutingPolicyDocument,
  context: RoutingContext,
): RoutingDecision {
  const policy = routingPolicyDocumentSchema.parse(document);
  const input = routingContextSchema.parse(context);
  const eligible = input.candidates.filter(
    (candidate) =>
      candidate.available &&
      (policy.maxCostMicros === undefined ||
        candidate.costMicros <= policy.maxCostMicros) &&
      (policy.minQuality === undefined ||
        candidate.qualityClass >= policy.minQuality) &&
      (policy.maxLatencyClass === undefined ||
        candidate.latencyClass <= policy.maxLatencyClass),
  );

  if (eligible.length === 0) {
    throw new Error("No routing candidate satisfies the policy");
  }

  let selected: z.output<typeof routingCandidateSchema> | undefined;
  let reason: string;

  if (input.requestedModel !== "auto") {
    selected = eligible.find(
      (candidate) => candidate.modelSlug === input.requestedModel,
    );
    reason = selected
      ? "requested_model_eligible"
      : "requested_model_ineligible";
  } else {
    reason = "auto_routing";
  }

  if (input.requestedModel === "auto" && input.platformDefaultModel) {
    const entitled = input.candidates.find(
      (candidate) => candidate.modelSlug === input.platformDefaultModel,
    );
    if (!entitled) {
      throw new Error(
        `Platform default ${input.platformDefaultModel} is not entitled on this API key`,
      );
    }
    const defaultEligible = eligible.find(
      (candidate) => candidate.modelSlug === input.platformDefaultModel,
    );
    if (!defaultEligible) {
      throw new Error(
        `Platform default ${input.platformDefaultModel} is blocked by routing policy constraints`,
      );
    }
    selected = defaultEligible;
    reason = `${reason}:platform_default`;
  }
  if (!selected) {
    selected = firstListedCandidate(policy.preferredModels, eligible);
    if (selected) {
      reason = `${reason}:preferred_model`;
    }
  }
  if (!selected) {
    selected = firstListedCandidate(policy.fallbackModels, eligible);
    if (selected) {
      reason = `${reason}:fallback_model`;
    }
  }
  if (!selected) {
    selected = [...eligible].sort(
      (left, right) =>
        left.costMicros - right.costMicros ||
        right.qualityClass - left.qualityClass ||
        left.latencyClass - right.latencyClass ||
        left.modelSlug.localeCompare(right.modelSlug),
    )[0];
    reason = `${reason}:best_eligible`;
  }

  if (!selected) {
    throw new Error("No routing candidate could be selected");
  }

  const decisionData = {
    resolvedModelSlug: selected.modelSlug,
    reason,
    policy,
    context: input,
  };
  return {
    resolvedModelSlug: selected.modelSlug,
    reason,
    decisionHash: hashCanonicalPayload(decisionData),
  };
}
