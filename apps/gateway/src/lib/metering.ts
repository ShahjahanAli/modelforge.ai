import {
  classifyUsageSlug,
  DEFAULT_STT_BILLABLE_UNITS_PER_SEC,
  summarizeUsageEvents,
  type MeterKind,
} from "@modelforge/platform";

export {
  classifyUsageSlug,
  DEFAULT_STT_BILLABLE_UNITS_PER_SEC,
  summarizeUsageEvents,
  type MeterKind,
};

/** Billable ledger units per second of transcribed audio (quota-facing). */
export function sttBillableUnitsPerSec(): number {
  return Math.max(1, Number(process.env.STT_BILLABLE_UNITS_PER_SEC ?? DEFAULT_STT_BILLABLE_UNITS_PER_SEC));
}

export function neo4jReadUnits(): number {
  return Math.max(1, Number(process.env.NEO4J_READ_BILLABLE_UNITS ?? 1));
}

export function neo4jWriteUnits(): number {
  return Math.max(1, Number(process.env.NEO4J_WRITE_BILLABLE_UNITS ?? 5));
}

export function audioDurationSec(input: {
  segments?: Array<{ endSec?: number; startSec?: number }>;
  text?: string;
  bytes?: number;
}): number {
  const ends = (input.segments ?? [])
    .map((s) => Number(s.endSec ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ends.length > 0) return Math.max(...ends);
  if (input.text?.trim()) return Math.max(1, input.text.trim().length / 12);
  if (input.bytes && input.bytes > 0) return Math.max(1, input.bytes / 16_000);
  return 1;
}

export function sttBillableUnits(durationSec: number): number {
  return Math.max(1, Math.ceil(durationSec * sttBillableUnitsPerSec()));
}
