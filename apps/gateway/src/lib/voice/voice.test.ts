import { describe, expect, it } from "vitest";
import { parseGeminiVoiceJson } from "./geminiAudio.js";
import {
  buildVoiceAnalysisPrompt,
  buildVoiceAnalysisSystemPrompt,
  resolveSttLanguageHint,
} from "./index.js";
import {
  coalesceTurns,
  collapseDuplicateAdjacentText,
  hasDuplicatedTurnText,
  mergeAsrSegmentsIntoTurns,
} from "./diarize.js";
import { resolvePyannoteCloudModel } from "./pyannoteCloud.js";
import { normalizeTranscript, isHallucinatedTranscriptText, repairSegmentTimestamps, type TranscriptArtifact } from "./types.js";

describe("gemini voice JSON parse", () => {
  it("parses speaker segments and analysis", () => {
    const raw = JSON.stringify({
      language: "bn",
      text: "hello there",
      analysis: "two party call",
      segments: [
        { speaker: "SPEAKER_00", startSec: 0, endSec: 1.5, text: "hello" },
        { speaker: "SPEAKER_01", start: 1.5, end: 3, text: "there" },
      ],
    });
    const parsed = parseGeminiVoiceJson(raw);
    expect(parsed.language).toBe("bn");
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[1]?.startSec).toBe(1.5);
    expect(parsed.analysis).toBe("two party call");
  });

  it("strips markdown fences", () => {
    const raw = "```json\n{\"language\":\"bn\",\"text\":\"ok\",\"segments\":[],\"analysis\":\"\"}\n```";
    expect(parseGeminiVoiceJson(raw).text).toBe("ok");
  });
});

describe("diarize-first helpers", () => {
  it("coalesces adjacent same-speaker turns", () => {
    const turns = coalesceTurns([
      { start: 0, end: 1.0, speaker: "SPEAKER_00" },
      { start: 1.2, end: 2.0, speaker: "SPEAKER_00" },
      { start: 2.5, end: 3.0, speaker: "SPEAKER_01" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ start: 0, end: 2.0, speaker: "SPEAKER_00" });
    expect(turns[1]?.speaker).toBe("SPEAKER_01");
  });

  it("merges ASR text into diarization turns without duplicating whole spans", () => {
    const merged = mergeAsrSegmentsIntoTurns(
      [
        { startSec: 0, endSec: 4, text: "hello there how are you today", speaker: null },
      ],
      [
        { start: 0, end: 2, speaker: "SPEAKER_00" },
        { start: 2, end: 4, speaker: "SPEAKER_01" },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.speaker).toBe("SPEAKER_00");
    expect(merged[1]?.speaker).toBe("SPEAKER_01");
    expect(merged[0]?.text).not.toEqual(merged[1]?.text);
  });

  it("detects duplicated turn text", () => {
    expect(
      hasDuplicatedTurnText([
        { startSec: 0, endSec: 1, text: "same long phrase repeated here again", speaker: "A" },
        { startSec: 1, endSec: 2, text: "same long phrase repeated here again", speaker: "B" },
        { startSec: 2, endSec: 3, text: "same long phrase repeated here again", speaker: "A" },
      ]),
    ).toBe(true);
  });

  it("collapses adjacent duplicate bubbles", () => {
    const out = collapseDuplicateAdjacentText([
      { startSec: 0, endSec: 1, text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", speaker: "A" },
      { startSec: 1, endSec: 2, text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", speaker: "A" },
      { startSec: 2, endSec: 3, text: "different text here", speaker: "B" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.endSec).toBe(2);
  });

  it("maps HF-style cloud model ids to API model names", () => {
    expect(resolvePyannoteCloudModel("precision-2")).toBe("precision-2");
    expect(resolvePyannoteCloudModel("pyannote/speaker-diarization-precision-2")).toBe(
      "precision-2",
    );
    expect(resolvePyannoteCloudModel("community-1")).toBe("community-1");
  });
});

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

  it("keeps opening segments and conversational না না bursts", () => {
    expect(isHallucinatedTranscriptText("ালো খাই", 0.5)).toBe(false);
    expect(isHallucinatedTranscriptText("না না না না কথাটা বলছেন নাই", 12)).toBe(false);
    expect(isHallucinatedTranscriptText("হ্যাঁ হ্যাঁ বুঝতে পারছে", 40)).toBe(false);
    expect(isHallucinatedTranscriptText("হ্যাঁ হ্যাঁ বুঝতে পারছে", 30, 51)).toBe(false);
    expect(
      isHallucinatedTranscriptText("তুই কি নাম্বার� ভুল নামি সেভ করছোস", 0, 0.48),
    ).toBe(false);
  });

  it("falls back when strict filter would drop every segment", () => {
    const noisy = "x".repeat(400);
    const artifact = normalizeTranscript({
      language: "bn",
      text: noisy,
      confidence: null,
      provider: "faster-whisper",
      model: "test",
      segments: [{ startSec: 40, endSec: 50, text: noisy, speaker: null }],
    });
    expect(artifact.text.length).toBeGreaterThan(0);
  });

  it("expands collapsed Whisper timestamps across the gap to the next segment", () => {
    const repaired = repairSegmentTimestamps(
      [
        { startSec: 0, endSec: 0.48, text: "a".repeat(120), speaker: null },
        { startSec: 30, endSec: 51.2, text: "second half", speaker: null },
      ],
      51.2,
    );
    expect(repaired[0]?.endSec).toBe(30);
    expect(repaired[1]?.startSec).toBe(30);
  });
});

describe("faster-whisper integration", () => {
  it.skipIf(!process.env.STT_INTEGRATION)("keeps Arnob opening through gateway STT provider", async () => {
    const { FasterWhisperProvider } = await import("./fasterWhisper.js");
    const { resolveVoicePath } = await import("./index.js");
    const audio = resolveVoicePath(
      "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav",
    );
    const script = resolveVoicePath(
      process.env.STT_FASTER_WHISPER_SCRIPT ?? "scripts/faster-whisper-transcribe.py",
    );
    const provider = new FasterWhisperProvider({
      pythonBin: process.env.STT_PYTHON_BIN ?? "python3",
      scriptPath: script,
      model: "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
      device: "cpu",
      computeType: "int8",
      beamSize: 5,
      bestOf: 5,
      temperature: 0,
      noSpeechThreshold: 0.35,
    });
    const result = await provider.transcribe(audio, { language: "bn" });
    expect(result.text.length).toBeGreaterThan(900);
    expect(result.text).toMatch(/শুনতে পাচ্ছ|হ্যা/);
    expect(result.segments[0]?.startSec ?? 0).toBeLessThan(1);
  }, 180_000);
});
