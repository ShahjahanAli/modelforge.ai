import { describe, expect, it } from "vitest";
import {
  buildVoiceAnalysisPrompt,
  buildVoiceAnalysisSystemPrompt,
  resolveSttLanguageHint,
} from "./index.js";
import { normalizeTranscript, type TranscriptArtifact } from "./types.js";

describe("voice transcript helpers", () => {
  it("normalizes transcript whitespace and drops empty segments", () => {
    const input: TranscriptArtifact = {
      language: "bn",
      text: "  আমি   বাংলাদেশে থাকি  ",
      confidence: 0.9,
      provider: "faster-whisper",
      model: "small",
      segments: [
        { startSec: 0, endSec: 1, text: "  আমি  ", speaker: null },
        { startSec: 1, endSec: 2, text: "   ", speaker: null },
        { startSec: 2, endSec: 3, text: "বাংলাদেশে   থাকি", speaker: null },
      ],
    };
    const normalized = normalizeTranscript(input);
    expect(normalized.text).toBe("আমি বাংলাদেশে থাকি");
    expect(normalized.segments).toHaveLength(2);
    expect(normalized.segments[0]?.text).toBe("আমি");
    expect(normalized.segments[1]?.text).toBe("বাংলাদেশে থাকি");
  });

  it("builds analysis prompt using provided instruction", () => {
    const transcript: TranscriptArtifact = {
      language: "bn",
      text: "কর রিটার্ন জমা দেওয়ার ধাপ বলুন",
      confidence: null,
      provider: "faster-whisper",
      model: "small",
      segments: [],
    };
    const prompt = buildVoiceAnalysisPrompt(transcript, "Give a concise summary");
    expect(prompt).toContain("Give a concise summary");
    expect(prompt).toContain("Detected transcript language:");
    expect(prompt).toContain("কর রিটার্ন");
  });

  it("returns null when analysis instruction is missing", () => {
    const prompt = buildVoiceAnalysisPrompt(
      {
        language: "en",
        text: "Hello world",
        confidence: null,
        provider: "faster-whisper",
        model: "small",
        segments: [],
      },
      "",
    );
    expect(prompt).toBeNull();
  });

  it("uses auto-detect when STT language hint is empty or auto", () => {
    expect(resolveSttLanguageHint("")).toBeUndefined();
    expect(resolveSttLanguageHint("auto")).toBeUndefined();
    expect(resolveSttLanguageHint("detect")).toBeUndefined();
    expect(resolveSttLanguageHint("bn")).toBe("bn");
  });

  it("builds language-neutral analysis system prompt", () => {
    const systemPrompt = buildVoiceAnalysisSystemPrompt({
      language: "en",
      text: "Hello",
      confidence: null,
      provider: "faster-whisper",
      model: "small",
      segments: [],
    });
    expect(systemPrompt).toContain("same language");
    expect(systemPrompt).not.toContain("Bangla");
  });
});

describe("diarization helpers", () => {
  it("coalesces adjacent same-speaker turns", async () => {
    const { coalesceTurns, toPublicTranscript } = await import("./diarize.js");
    const merged = coalesceTurns([
      { start: 0, end: 1.0, speaker: "SPEAKER_00" },
      { start: 1.2, end: 2.0, speaker: "SPEAKER_00" },
      { start: 2.5, end: 3.0, speaker: "SPEAKER_01" },
    ]);
    expect(merged).toEqual([
      { start: 0, end: 2.0, speaker: "SPEAKER_00" },
      { start: 2.5, end: 3.0, speaker: "SPEAKER_01" },
    ]);

    const pub = toPublicTranscript({
      language: "bn",
      text: "hello",
      confidence: null,
      provider: "nemo+pyannote",
      model: "bhatiyali",
      segments: [{ startSec: 1.25, endSec: 2.5, text: "hello", speaker: "SPEAKER_00" }],
    });
    expect(pub.segments[0]?.start).toBe(1.25);
    expect(pub.segments[0]?.end).toBe(2.5);
    expect(pub.speakers).toEqual(["SPEAKER_00"]);
  });
});
