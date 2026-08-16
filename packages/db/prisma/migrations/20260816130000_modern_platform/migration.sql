-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HostedModel" ADD COLUMN IF NOT EXISTS "qualityClass" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "HostedModel" ADD COLUMN IF NOT EXISTS "latencyClass" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "HostedModel" ADD COLUMN IF NOT EXISTS "supportsTools" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "QuotaLedger" ADD COLUMN IF NOT EXISTS "tokensReserved" BIGINT NOT NULL DEFAULT 0;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "InferenceStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "InvoiceLineType" AS ENUM ('USAGE', 'SUBSCRIPTION', 'CREDIT', 'ADJUSTMENT', 'OVERAGE');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "PolicyKind" AS ENUM ('ROUTING', 'BUDGET', 'DATA', 'TOOL', 'SLO');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "PolicyScope" AS ENUM ('PLATFORM', 'PLAN', 'CUSTOMER', 'API_KEY');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELED', 'PREEMPTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "NodeStatus" AS ENUM ('ONLINE', 'DEGRADED', 'OFFLINE', 'QUARANTINED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'WARM', 'COLD', 'DRAINING', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "SloWindowStatus" AS ENUM ('HEALTHY', 'AT_RISK', 'BREACHED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "EvalRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "IngestionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "KnowledgeSensitivity" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlanModelEntitlement" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanModelEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PricingVersion" (
    "id" TEXT NOT NULL,
    "hostedModelId" TEXT NOT NULL,
    "pricePerMTokIn" INTEGER NOT NULL,
    "pricePerMTokOut" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PricingVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QuotaLedgerEntry" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "deltaTokens" BIGINT NOT NULL,
    "reservedDelta" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuotaLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" "InvoiceLineType" NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InferenceRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "status" "InferenceStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedModelId" TEXT,
    "requestedModelSlug" TEXT NOT NULL,
    "resolvedModelId" TEXT,
    "resolvedModelSlug" TEXT,
    "pricingVersionId" TEXT,
    "policyVersionId" TEXT,
    "policyDecisionHash" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "queueMs" INTEGER NOT NULL DEFAULT 0,
    "coldStartMs" INTEGER NOT NULL DEFAULT 0,
    "ttftMs" INTEGER,
    "generationMs" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "finishReason" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "nodeId" TEXT,
    "hardwareProfileId" TEXT,
    "receiptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "InferenceRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InferenceAttempt" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "backend" TEXT NOT NULL,
    "nodeId" TEXT,
    "modelSlug" TEXT NOT NULL,
    "status" "InferenceStatus" NOT NULL DEFAULT 'QUEUED',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "queueMs" INTEGER NOT NULL DEFAULT 0,
    "coldStartMs" INTEGER NOT NULL DEFAULT 0,
    "ttftMs" INTEGER,
    "generationMs" INTEGER NOT NULL DEFAULT 0,
    "cancelReason" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "hardwareProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "firstTokenAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "InferenceAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UsageReceipt" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "usageEventId" TEXT,
    "payloadCanonical" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'Ed25519',
    "signingKeyId" TEXT NOT NULL,
    "previousHash" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SigningKey" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'Ed25519',
    "publicKey" TEXT NOT NULL,
    "privateRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "SigningKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "customerId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "requestId" TEXT,
    "beforeHash" TEXT,
    "afterHash" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Policy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PolicyKind" NOT NULL,
    "scope" "PolicyScope" NOT NULL DEFAULT 'PLATFORM',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PolicyBinding" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "planId" TEXT,
    "customerId" TEXT,
    "apiKeyId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BudgetAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "name" TEXT NOT NULL,
    "modelSlug" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "limitMicros" BIGINT NOT NULL,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,
    "softLimitPct" INTEGER NOT NULL DEFAULT 80,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BudgetAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BudgetReservation" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "requestId" TEXT,
    "amountMicros" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    CONSTRAINT "BudgetReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RuntimeNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'local',
    "jurisdiction" TEXT,
    "status" "NodeStatus" NOT NULL DEFAULT 'ONLINE',
    "totalRamMb" INTEGER NOT NULL DEFAULT 0,
    "freeRamMb" INTEGER NOT NULL DEFAULT 0,
    "cpuCores" INTEGER NOT NULL DEFAULT 0,
    "capabilities" JSONB,
    "trustState" TEXT NOT NULL DEFAULT 'local',
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RuntimeNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NodeHeartbeat" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NodeHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ModelDeployment" (
    "id" TEXT NOT NULL,
    "hostedModelId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "ramMb" INTEGER NOT NULL DEFAULT 0,
    "port" INTEGER,
    "pid" INTEGER,
    "revisionId" TEXT,
    "profileId" TEXT,
    "lastError" TEXT,
    "warmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ModelDeployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ResidencyReservation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "hostedModelId" TEXT NOT NULL,
    "nodeId" TEXT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "ramMb" INTEGER NOT NULL,
    "minWarmMinutes" INTEGER NOT NULL DEFAULT 30,
    "preemptible" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResidencyReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HardwareProfile" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nThreads" INTEGER NOT NULL,
    "contextLength" INTEGER NOT NULL,
    "batchSize" INTEGER NOT NULL DEFAULT 512,
    "useMmap" BOOLEAN NOT NULL DEFAULT true,
    "gpuLayers" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HardwareProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TuningTrial" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL,
    "tokPerSec" DOUBLE PRECISION NOT NULL,
    "ttftMs" DOUBLE PRECISION NOT NULL,
    "loadMs" DOUBLE PRECISION NOT NULL,
    "ramMb" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "promoted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TuningTrial_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SloDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "latencyP95Ms" INTEGER NOT NULL,
    "availabilityPct" DOUBLE PRECISION NOT NULL,
    "windowMinutes" INTEGER NOT NULL DEFAULT 60,
    "creditMicros" BIGINT NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SloDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SloWindow" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "customerId" TEXT,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "breachCount" INTEGER NOT NULL DEFAULT 0,
    "p95LatencyMs" INTEGER NOT NULL DEFAULT 0,
    "availabilityPct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "status" "SloWindowStatus" NOT NULL DEFAULT 'HEALTHY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SloWindow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SloViolation" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "requestId" TEXT,
    "reason" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SloViolation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ServiceCredit" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amountMicros" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceCredit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ModelRevision" (
    "id" TEXT NOT NULL,
    "hostedModelId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "weightsHash" TEXT,
    "changelog" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvalSuite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvalSuite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvalCase" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "expected" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvalCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvalRun" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "status" "EvalRunStatus" NOT NULL DEFAULT 'PENDING',
    "score" DOUBLE PRECISION,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvalResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseName" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "score" DOUBLE PRECISION,
    "output" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CanaryChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostedModelId" TEXT NOT NULL,
    "stableRevisionId" TEXT,
    "trafficPct" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CanaryChannel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sensitivity" "KnowledgeSensitivity" NOT NULL DEFAULT 'INTERNAL',
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceUri" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'text/plain',
    "status" "IngestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "embedding" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RetrievalRun" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "queryHash" TEXT NOT NULL,
    "topK" INTEGER NOT NULL,
    "hits" JSONB NOT NULL,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetrievalRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MemoryNamespace" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryNamespace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MemoryEntry" (
    "id" TEXT NOT NULL,
    "namespaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MemoryEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NodeCommand" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "NodeCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FederationOffer" (
    "id" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "priceMicros" BIGINT NOT NULL,
    "region" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FederationOffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FederationSettlement" (
    "id" TEXT NOT NULL,
    "offerId" TEXT,
    "requestId" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FederationSettlement_pkey" PRIMARY KEY ("id")
);

-- Alter UsageEvent
ALTER TABLE "UsageEvent" ADD COLUMN IF NOT EXISTS "inferenceRequestId" TEXT;

-- Unique / indexes (ignore if exist via DO blocks where needed)
CREATE UNIQUE INDEX IF NOT EXISTS "PlanModelEntitlement_planId_modelSlug_key" ON "PlanModelEntitlement"("planId", "modelSlug");
CREATE UNIQUE INDEX IF NOT EXISTS "QuotaLedgerEntry_idempotencyKey_key" ON "QuotaLedgerEntry"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "SigningKey_keyId_key" ON "SigningKey"("keyId");
CREATE UNIQUE INDEX IF NOT EXISTS "UsageReceipt_requestId_key" ON "UsageReceipt"("requestId");
CREATE UNIQUE INDEX IF NOT EXISTS "UsageReceipt_usageEventId_key" ON "UsageReceipt"("usageEventId");
CREATE UNIQUE INDEX IF NOT EXISTS "Policy_name_kind_scope_key" ON "Policy"("name", "kind", "scope");
CREATE UNIQUE INDEX IF NOT EXISTS "PolicyVersion_policyId_version_key" ON "PolicyVersion"("policyId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetReservation_idempotencyKey_key" ON "BudgetReservation"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "RuntimeNode_name_key" ON "RuntimeNode"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "ModelDeployment_hostedModelId_nodeId_key" ON "ModelDeployment"("hostedModelId", "nodeId");
CREATE UNIQUE INDEX IF NOT EXISTS "HardwareProfile_nodeId_name_key" ON "HardwareProfile"("nodeId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "SloDefinition_name_key" ON "SloDefinition"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "ModelRevision_hostedModelId_revision_key" ON "ModelRevision"("hostedModelId", "revision");
CREATE UNIQUE INDEX IF NOT EXISTS "EvalSuite_name_key" ON "EvalSuite"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "CanaryChannel_name_key" ON "CanaryChannel"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeBase_customerId_name_key" ON "KnowledgeBase"("customerId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeChunk_versionId_ordinal_key" ON "KnowledgeChunk"("versionId", "ordinal");
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryNamespace_customerId_name_key" ON "MemoryNamespace"("customerId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryEntry_namespaceId_key_key" ON "MemoryEntry"("namespaceId", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "NodeCommand_nonce_key" ON "NodeCommand"("nonce");
CREATE UNIQUE INDEX IF NOT EXISTS "InferenceAttempt_requestId_attemptNo_key" ON "InferenceAttempt"("requestId", "attemptNo");
CREATE UNIQUE INDEX IF NOT EXISTS "FederationSettlement_requestId_nodeName_key" ON "FederationSettlement"("requestId", "nodeName");
CREATE UNIQUE INDEX IF NOT EXISTS "UsageEvent_inferenceRequestId_key" ON "UsageEvent"("inferenceRequestId");

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "PlanModelEntitlement" ADD CONSTRAINT "PlanModelEntitlement_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "PricingVersion" ADD CONSTRAINT "PricingVersion_hostedModelId_fkey" FOREIGN KEY ("hostedModelId") REFERENCES "HostedModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "QuotaLedgerEntry" ADD CONSTRAINT "QuotaLedgerEntry_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "QuotaLedger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "InferenceRequest" ADD CONSTRAINT "InferenceRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "InferenceRequest" ADD CONSTRAINT "InferenceRequest_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "InferenceAttempt" ADD CONSTRAINT "InferenceAttempt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "InferenceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "UsageReceipt" ADD CONSTRAINT "UsageReceipt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "InferenceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_inferenceRequestId_fkey" FOREIGN KEY ("inferenceRequestId") REFERENCES "InferenceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "PolicyBinding" ADD CONSTRAINT "PolicyBinding_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetAccount" ADD CONSTRAINT "BudgetAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "BudgetReservation" ADD CONSTRAINT "BudgetReservation_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "BudgetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "NodeHeartbeat" ADD CONSTRAINT "NodeHeartbeat_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "RuntimeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ModelDeployment" ADD CONSTRAINT "ModelDeployment_hostedModelId_fkey" FOREIGN KEY ("hostedModelId") REFERENCES "HostedModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ModelDeployment" ADD CONSTRAINT "ModelDeployment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "RuntimeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ResidencyReservation" ADD CONSTRAINT "ResidencyReservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ResidencyReservation" ADD CONSTRAINT "ResidencyReservation_hostedModelId_fkey" FOREIGN KEY ("hostedModelId") REFERENCES "HostedModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "HardwareProfile" ADD CONSTRAINT "HardwareProfile_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "RuntimeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "TuningTrial" ADD CONSTRAINT "TuningTrial_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "HardwareProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "SloWindow" ADD CONSTRAINT "SloWindow_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "SloDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "SloViolation" ADD CONSTRAINT "SloViolation_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "SloDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ServiceCredit" ADD CONSTRAINT "ServiceCredit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "ModelRevision" ADD CONSTRAINT "ModelRevision_hostedModelId_fkey" FOREIGN KEY ("hostedModelId") REFERENCES "HostedModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "EvalSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "EvalSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ModelRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "CanaryChannel" ADD CONSTRAINT "CanaryChannel_hostedModelId_fkey" FOREIGN KEY ("hostedModelId") REFERENCES "HostedModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "MemoryNamespace" ADD CONSTRAINT "MemoryNamespace_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "MemoryEntry" ADD CONSTRAINT "MemoryEntry_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "MemoryNamespace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "NodeCommand" ADD CONSTRAINT "NodeCommand_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "RuntimeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
