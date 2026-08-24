-- Remote / OpenAI-compatible LLM providers (OpenRouter, etc.)
CREATE TYPE "InferenceProviderKind" AS ENUM ('LOCAL_GGUF', 'OPENAI_COMPAT');

CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "providerKind" "InferenceProviderKind" NOT NULL DEFAULT 'OPENAI_COMPAT',
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "HostedModel" ALTER COLUMN "weightsPath" SET DEFAULT '';
ALTER TABLE "HostedModel" ALTER COLUMN "quantization" SET DEFAULT 'remote';
ALTER TABLE "HostedModel" ALTER COLUMN "contextLength" SET DEFAULT 8192;

ALTER TABLE "HostedModel" ADD COLUMN "providerKind" "InferenceProviderKind" NOT NULL DEFAULT 'LOCAL_GGUF';
ALTER TABLE "HostedModel" ADD COLUMN "remoteBaseUrl" TEXT;
ALTER TABLE "HostedModel" ADD COLUMN "remoteModelId" TEXT;
ALTER TABLE "HostedModel" ADD COLUMN "credentialId" TEXT;

CREATE INDEX "HostedModel_providerKind_idx" ON "HostedModel"("providerKind");
CREATE INDEX "HostedModel_credentialId_idx" ON "HostedModel"("credentialId");

ALTER TABLE "HostedModel" ADD CONSTRAINT "HostedModel_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "ProviderCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
