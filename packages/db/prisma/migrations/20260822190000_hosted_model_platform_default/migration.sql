-- Platform-wide default model for model:auto routing.
ALTER TABLE "HostedModel" ADD COLUMN "isPlatformDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "HostedModel_single_platform_default"
  ON "HostedModel"("isPlatformDefault")
  WHERE "isPlatformDefault" = true;
