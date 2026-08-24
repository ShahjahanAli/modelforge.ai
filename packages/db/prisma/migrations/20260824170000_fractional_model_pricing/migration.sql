-- Allow fractional ¢ / MTok pricing (e.g. Gemini 0.75 / 3.75).
ALTER TABLE "HostedModel"
  ALTER COLUMN "pricePerMTokIn" TYPE DOUBLE PRECISION,
  ALTER COLUMN "pricePerMTokOut" TYPE DOUBLE PRECISION;

ALTER TABLE "PricingVersion"
  ALTER COLUMN "pricePerMTokIn" TYPE DOUBLE PRECISION,
  ALTER COLUMN "pricePerMTokOut" TYPE DOUBLE PRECISION;
