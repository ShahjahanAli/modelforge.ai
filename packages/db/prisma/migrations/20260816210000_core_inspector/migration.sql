-- Opt-in inference core diagnostics. Sessions expire automatically and claim
-- one request; event rows exist only while tracing has explicitly been armed.
CREATE TABLE "CoreTraceSession" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "requestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ARMED',
    "mode" TEXT NOT NULL DEFAULT 'STANDARD',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoreTraceSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CoreTraceEvent" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "atMs" INTEGER NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoreTraceEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoreTraceSession_requestId_key" ON "CoreTraceSession"("requestId");
CREATE INDEX "CoreTraceSession_customerId_status_expiresAt_idx"
    ON "CoreTraceSession"("customerId", "status", "expiresAt");
CREATE INDEX "CoreTraceSession_createdAt_idx" ON "CoreTraceSession"("createdAt");
CREATE UNIQUE INDEX "CoreTraceEvent_traceId_sequence_key"
    ON "CoreTraceEvent"("traceId", "sequence");
CREATE INDEX "CoreTraceEvent_traceId_createdAt_idx"
    ON "CoreTraceEvent"("traceId", "createdAt");

ALTER TABLE "CoreTraceSession"
    ADD CONSTRAINT "CoreTraceSession_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoreTraceSession"
    ADD CONSTRAINT "CoreTraceSession_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "InferenceRequest"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CoreTraceEvent"
    ADD CONSTRAINT "CoreTraceEvent_traceId_fkey"
    FOREIGN KEY ("traceId") REFERENCES "CoreTraceSession"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
