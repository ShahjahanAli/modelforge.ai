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

  it("defaults to bn for Bengali-tuned models when STT language is auto", () => {
    expect(
      resolveSttLanguageHint("auto", "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium"),
    ).toBe("bn");
    expect(resolveSttLanguageHint("", "kazalbrur/bangla-stt-conformer-120m-dialects")).toBe("bn");
    expect(resolveSttLanguageHint("auto", "small")).toBeUndefined();
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

  it("assigns speakers to ASR segments by overlap", async () => {
    const { assignSpeakersToSegments } = await import("./diarize.js");
    const turns = [
      { start: 0, end: 2.5, speaker: "SPEAKER_00" },
      { start: 2.5, end: 5.0, speaker: "SPEAKER_01" },
      { start: 5.0, end: 8.0, speaker: "SPEAKER_00" },
    ];
    const segments = [
      { startSec: 0.5, endSec: 1.2, text: "hello" },
      { startSec: 2.8, endSec: 4.1, text: "yes I hear you" },
      { startSec: 5.4, endSec: 7.0, text: "about the project" },
    ];
    const labeled = assignSpeakersToSegments(segments, turns);
    expect(labeled[0]?.speaker).toBe("SPEAKER_00");
    expect(labeled[1]?.speaker).toBe("SPEAKER_01");
    expect(labeled[2]?.speaker).toBe("SPEAKER_00");
  });

  it("merges multi-segment ASR into diarization turns", async () => {
    const { mergeAsrSegmentsIntoTurns } = await import("./diarize.js");
    const turns = [
      { start: 0, end: 3.0, speaker: "SPEAKER_00" },
      { start: 3.0, end: 6.5, speaker: "SPEAKER_01" },
    ];
    const segments = [
      { startSec: 0.5, endSec: 1.2, text: "hello" },
      { startSec: 1.3, endSec: 2.8, text: "brother" },
      { startSec: 3.2, endSec: 4.5, text: "yes I hear" },
      { startSec: 4.6, endSec: 6.0, text: "you" },
    ];
    const merged = mergeAsrSegmentsIntoTurns(segments, turns);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.speaker).toBe("SPEAKER_00");
    expect(merged[0]?.text).toContain("hello");
    expect(merged[1]?.speaker).toBe("SPEAKER_01");
    expect(merged[1]?.text).toContain("yes I hear");
  });

  it("time-slices one long ASR segment across many diarization turns", async () => {
    const { mergeAsrSegmentsIntoTurns, hasDuplicatedTurnText, sliceTextByTimeOverlap } =
      await import("./diarize.js");
    const long =
      "তো সেখানে রুফিক ভাই লিখেছে যে এটা আমাদের যেহেতু অনেক টাইপ টেইল লাইন আছে " +
      "আমার নামটা বলো তো জাহাঙ্গীর মোহাম্মদ শাহাজাহান আলী";
    const turns = [
      { start: 0, end: 4, speaker: "SPEAKER_00" },
      { start: 4, end: 8, speaker: "SPEAKER_01" },
      { start: 8, end: 12, speaker: "SPEAKER_00" },
    ];
    const segments = [{ startSec: 0, endSec: 12, text: long }];
    const merged = mergeAsrSegmentsIntoTurns(segments, turns);
    expect(merged).toHaveLength(3);
    expect(hasDuplicatedTurnText(merged)).toBe(false);
    expect(merged[0]?.text).not.toEqual(merged[1]?.text);
    expect(sliceTextByTimeOverlap(long, 0, 12, 0, 4).split(/\s+/).length).toBeLessThan(
      long.split(/\s+/).length,
    );
  });

  it("collapses adjacent duplicate turn texts", async () => {
    const { collapseDuplicateAdjacentText } = await import("./diarize.js");
    const same =
      "তো সেখানে রুফিক ভাই লিখেছে যে এটা আমাদের যেহেতু অনেক টাইপ টেইল লাইন আছে আর কি";
    const collapsed = collapseDuplicateAdjacentText([
      { startSec: 1, endSec: 2, text: same, speaker: "A" },
      { startSec: 2, endSec: 3, text: same, speaker: "A" },
      { startSec: 3, endSec: 4, text: "short ok", speaker: "B" },
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]?.endSec).toBe(3);
  });
});
