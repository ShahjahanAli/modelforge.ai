# Feature: Two-tier vocabulary system for ASR bias + normalization constraint

## Why this exists

Two failure modes are currently entangled and need to be pulled apart:

1. **ASR mishears known words** (তারেখ instead of তারেক, ট্রিভেন instead of ড্রিভেন) because the
   model has no prior on what vocabulary to expect.
2. **Normalize/extract LLM stages "fix" ambiguous spans by guessing** — this is the dangerous one,
   because a fabricated but fluent-sounding name or term (e.g. "দ্যাটস অয়" → "অ্যাক্সেস") looks
   *more* trustworthy after cleanup, not less, even though nothing verified it.

The fix for both is the same mechanism: a controlled vocabulary that (a) biases ASR toward likely-
correct words, and (b) constrains the LLM to only ever resolve ambiguity using terms that have actual
provenance — never its own prior guess.

**Hard rule, non-negotiable:** an entry only enters the case-specific vocabulary from a source with real
provenance (case intake form, phone metadata, an analyst who verified it by listening to the audio).
**A prior ASR or LLM guess about this same audio is never a valid source for a vocabulary entry.**
Violating this turns the vocabulary into a circularity engine — the pipeline becomes more *confident*
about content nobody ever verified, which is worse than the current failure mode, not better.

---

## Data model

Two separate tables/collections. Do not merge them — they have different lifecycles, different
provenance rules, and different scopes.

### 1. `global_vocabulary` — platform-wide, safe to populate proactively

Common code-switched English loanwords and general domain jargon that recur across any case,
independent of any specific investigation. No verification bottleneck — build this from a glossary
now.

```json
{
  "term": "ড্রিভেন",
  "type": "code_switch_term",
  "phonetic_variants": ["ট্রিভেন", "ড্রাইভেন", "দ্রিভেন"],
  "canonical_english": "driven",
  "category": "tech_jargon"
}
```

Seed list (starter set — extend as real cases surface more terms):

| Term (canonical Bangla script) | Phonetic ASR variants seen | English gloss | Category |
|---|---|---|---|
| এআই | আই, এ.আই | AI | tech |
| ড্রিভেন | ট্রিভেন, ড্রাইভেন, দ্রিভেন | driven | tech |
| ডেটাসেট | দাটসা, দেটসয়, দ্যাটস অয় | dataset | tech |
| প্রজেক্ট | প্রজেক্‌ | project | tech |
| অডিও রেকর্ড | অডিও রেকড, অডিয়ো রেকর্ড | audio record | tech |
| মিটিং | মিটং | meeting | general |
| ট্রান্সফার | ট্রান্সফর | transfer | finance |
| একাউন্ট | আকাউন্ট, একাওন্ট | account | finance |
| ইনভেস্টমেন্ট | ইনভেস্মেন্ট | investment | finance |
| ম্যানেজার | মেনেজার | manager | general |
| শুনতে পাচ্ছিস | কুনতে পাচ্ছ, সুন্দর হচ্ছি | (hear-check disfluency) | disfluency |
| নিয়ে | নিয়া | (standard/dialect particle) | disfluency |
| বল তো | বলত | (standard/dialect particle) | disfluency |

### 2. `case_vocabulary` — per-case, only from verified sources

Names, places, org names specific to one investigation. Every entry must carry provenance.

```json
{
  "term": "তারেক",
  "type": "person",
  "phonetic_variants": ["তারেখ", "তারেগ"],
  "case_id": "CASE-2026-0417",
  "source": "case_intake_form | phone_metadata | analyst_verified",
  "verified_by": "R. Ahmed",
  "verified_at": "2026-08-20T14:02:00Z",
  "verification_note": "Confirmed by listening to call CALL-88213 at 0:01.651 — caller self-identifies contact by name",
  "confidence": "confirmed"
}
```

`source` and `verified_by` are **required fields**, not optional metadata. Reject any insert that
lacks them at the API/schema level — this is the enforcement point that prevents circularity, not a
convention to remember.

---

## Integration point 1: ASR vocabulary bias

Before transcription, assemble a hint list from `global_vocabulary` (always) + `case_vocabulary` for
the active case (confirmed entries only).

```python
def build_asr_hints(case_id: str) -> str:
    global_terms = [t["term"] for t in get_global_vocabulary()]
    case_terms = [
        t["term"] for t in get_case_vocabulary(case_id)
        if t["confidence"] == "confirmed"
    ]
    return ", ".join(global_terms + case_terms)

# faster-whisper
segments, info = model.transcribe(
    audio_path,
    initial_prompt=build_asr_hints(case_id),
    language="bn",
)
```

For the NeMo/Conformer path (`kazalbrur/bangla-stt-conformer-120m-dialects`), check whether the
inference wrapper supports a comparable hotword/boosting parameter — CTC-based models vary in
support for this; if unsupported, this vocabulary still applies at integration points 2 and 3 below,
just not at the acoustic stage for that model.

**Do not include unconfirmed/flagged case entries here.** Only `confidence: "confirmed"` entries bias
the ASR — anything still under review has no business influencing what the model thinks it hears.

---

## Integration point 2: Normalize stage — `ALLOWED_NAMES` constraint

Extend the existing normalize prompt (from `FIX-entity-extraction-empty-result.md` context) with an
explicit allow-list. The model may resolve an ambiguous span **only** if it maps to an entry in this
list — otherwise it must leave the span untouched and flag it.

```
You are given two vocabulary lists for this case.

GLOBAL_TERMS (safe to use for fixing code-switched/technical words in any context):
{{global_vocabulary_terms}}

ALLOWED_NAMES (the only names/places/orgs you may use to resolve an ambiguous span in this call):
{{case_vocabulary_confirmed_terms}}

RULES:
1. If a span phonetically resembles an entry in GLOBAL_TERMS or ALLOWED_NAMES, you may replace it
   with that entry's canonical form. Record this in "changes" with type "vocabulary_match".
2. If a span looks like a name, place, or proper noun but does NOT match anything in ALLOWED_NAMES,
   you MUST leave it exactly as transcribed and add it to "flagged_uncertain". Do not propose your
   own reading, even if you believe you know what it says.
3. Everything else follows the existing disfluency/code-switch rules already in place.
```

This directly replaces the failure mode from the earlier "দ্যাটস অয় → অ্যাক্সেস" incident: "অয়"
would now only resolve to "ডেটাসেট" if that term is in `GLOBAL_TERMS` (it should be, per the seed
list above) — and a genuinely unlisted ambiguous span stays untouched instead of getting a confident
wrong guess.

---

## Integration point 3: Extraction stage

Same `ALLOWED_NAMES` list, used the same way, applied to the entity-extraction prompt (JSON-schema
constrained, per the earlier fix doc). An extracted `person` entity should carry a `matched_vocabulary`
boolean — `true` if it came from a confirmed case entry, `false`/absent if the model is asserting a
name that wasn't in the allow-list. Any `false` entity should render in the UI as **provisional,
needs verification** — not as a confirmed entity in the graph.

---

## Integration point 4: The verification loop (this is what makes the vocabulary trustworthy over time)

When an analyst reviews a `flagged_uncertain` span in the raw/normalized diff UI and confirms it by
listening to the audio at that timestamp, that confirmation is the **only** path that writes a new
entry into `case_vocabulary`.

```
UI: analyst clicks flagged span → plays audio at that timestamp → confirms "yes, this is [X]"
  → POST /v1/cases/{case_id}/vocabulary
      { term, phonetic_variant: <original ASR span>, source: "analyst_verified",
        verified_by: <current user>, verification_note: <call_id + timestamp> }
  → entry now available for ASR bias + ALLOWED_NAMES on next re-run in this case
```

This is intentionally the *only* write path into `case_vocabulary` besides case intake and phone
metadata import. Do not add a "promote LLM guess to vocabulary" button or auto-promotion logic
anywhere — that reintroduces the exact circularity this whole feature exists to prevent.

---

## Schema additions (Postgres)

```sql
CREATE TABLE global_vocabulary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term TEXT NOT NULL,
  type TEXT NOT NULL,
  phonetic_variants TEXT[] DEFAULT '{}',
  canonical_english TEXT,
  category TEXT
);

CREATE TABLE case_vocabulary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id),
  term TEXT NOT NULL,
  type TEXT NOT NULL, -- person | place | org
  phonetic_variants TEXT[] DEFAULT '{}',
  source TEXT NOT NULL CHECK (source IN ('case_intake_form', 'phone_metadata', 'analyst_verified')),
  verified_by TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verification_note TEXT,
  confidence TEXT NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed', 'provisional'))
);
```

`source` and `verified_by` are `NOT NULL` at the schema level on purpose — this is the enforcement
point, not the application layer alone.

---

## Verification checklist

- [ ] `global_vocabulary` seeded from the starter list above, extendable via admin UI.
- [ ] `case_vocabulary` insert is rejected without `source` + `verified_by`.
- [ ] No code path exists that writes to `case_vocabulary` from an LLM/ASR output directly.
- [ ] ASR `initial_prompt` includes global + confirmed case terms only.
- [ ] Normalize prompt includes `ALLOWED_NAMES` constraint and produces `flagged_uncertain` for
      anything outside it.
- [ ] Extraction output tags `matched_vocabulary: true/false` per entity; `false` entities render as
      provisional in the UI, not as confirmed graph nodes.
- [ ] Analyst confirmation flow writes to `case_vocabulary` with full provenance and immediately
      becomes available for the next ASR/normalize run on that case.
- [ ] Re-run the reference test file (once a human-verified transcript exists, per prior discussion)
      before vs. after vocabulary integration to measure actual improvement against real ground
      truth — not against any prior unverified guess.
