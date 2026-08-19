-- Keep billing/inference history after a hosted model is removed from the registry.
ALTER TABLE "UsageEvent" ALTER COLUMN "modelId" DROP NOT NULL;

ALTER TABLE "UsageEvent" DROP CONSTRAINT IF EXISTS "UsageEvent_modelId_fkey";
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "HostedModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InferenceRequest" DROP CONSTRAINT IF EXISTS "InferenceRequest_requestedModelId_fkey";
ALTER TABLE "InferenceRequest" ADD CONSTRAINT "InferenceRequest_requestedModelId_fkey"
  FOREIGN KEY ("requestedModelId") REFERENCES "HostedModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InferenceRequest" DROP CONSTRAINT IF EXISTS "InferenceRequest_resolvedModelId_fkey";
ALTER TABLE "InferenceRequest" ADD CONSTRAINT "InferenceRequest_resolvedModelId_fkey"
  FOREIGN KEY ("resolvedModelId") REFERENCES "HostedModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InferenceRequest" DROP CONSTRAINT IF EXISTS "InferenceRequest_pricingVersionId_fkey";
ALTER TABLE "InferenceRequest" ADD CONSTRAINT "InferenceRequest_pricingVersionId_fkey"
  FOREIGN KEY ("pricingVersionId") REFERENCES "PricingVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
