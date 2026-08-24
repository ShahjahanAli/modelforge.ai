# Fix: Entity extraction returns "No structured entities" with Qwen3-32B

## Symptom

- Normalizer step succeeds (`Applied: Yes (text changed)`, diff looks reasonable).
- Entity extraction step returns **zero entities** (`persons: 0 · events: 0 · relationships: 0` /
  "No structured entities") when the model is `qwen/qwen3-32b` via OpenRouter.
- The same pipeline with `qwen3-8b` previously returned `persons: 1 · events: 2 · relationships: 3`
  on comparable input.
- A bigger, generally more capable model producing *fewer* results than a smaller one is a strong
  signal this is a **parsing/format bug**, not an extraction-quality problem. Do not tune prompts
  for "better extraction" until this is ruled out.

## Root cause hypotheses, ranked by likelihood

### 1. Reasoning/thinking-mode leakage into the JSON payload (most likely)

Qwen3-series models are hybrid reasoning models. Depending on how the request is sent, the model
may emit a `<think>...</think>` block (or similar reasoning preamble) **before** the actual answer.
If the extraction prompt requires a JSON-only response and the code does something like:

```ts
const entities = JSON.parse(response.choices[0].message.content);
```

...this will throw the instant there's a `<think>` block, a markdown code fence, or any leading
prose ahead of the `{`. If that throw is caught and silently defaulted to an empty result, you get
exactly this symptom with no visible error anywhere in the UI.

**Action:**
- [ ] Log the **raw, unparsed** `message.content` from the model on every extraction call (at least
      in a debug/dev mode), not just the parsed result. Re-run this exact case and inspect the raw
      output.
- [ ] Check whether the raw output contains a `<think>` tag, a ```` ```json ```` fence, or any text
      before the first `{`.
- [ ] If present: strip reasoning/fence wrapper before parsing (see fix below), and/or explicitly
      disable thinking mode for this call if the provider exposes that control (Qwen3 models
      typically support disabling via a chat-template flag or a `/no_think` style instruction —
      check what OpenRouter exposes for this specific model slug, since providers vary).

### 2. OpenRouter backend inconsistency

OpenRouter can route the same model slug (`qwen/qwen3-32b`) to different underlying providers/hosts,
which may differ in:
- Whether they respect `response_format: { type: "json_object" }` / structured-output mode
- Default sampling params
- Whether thinking mode is on by default

**Action:**
- [ ] Check whether the OpenRouter request is pinning a specific provider (`provider: { order: [...] }`
      or similar) or letting it route freely. If free-routing, pin it for this test so results are
      reproducible.
- [ ] Check whether `response_format: { type: "json_object" }` (or OpenRouter's equivalent structured
      output param) is being sent. If not, add it — this is the single highest-leverage fix if the
      provider supports it.
- [ ] Compare raw output across 3-5 repeated calls. If format varies between calls, it's provider-side
      inconsistency, not a one-off fluke.

### 3. Prompt/schema mismatch specific to larger context reasoning

Less likely, but worth ruling out: if the extraction prompt was tuned against Qwen3-8B's tendency to
answer directly, a 32B model with more "reasoning headroom" may be more likely to add caveats,
explanations, or partial answers around the JSON rather than emitting it raw — even without explicit
thinking-mode tokens.

**Action:**
- [ ] If hypothesis 1 and 2 are ruled out, tighten the extraction prompt to be more explicit that
      *only* JSON is acceptable output, with no leading or trailing text under any circumstance —
      the same discipline already applied to the normalizer prompt.

## Required fix (apply regardless of which hypothesis is confirmed)

1. **Never let a JSON parse failure silently resolve to "zero entities."** Distinguish these two
   cases explicitly in the UI/logs:
   - `entities: []` — model ran, returned valid JSON, genuinely found nothing.
   - `extraction_failed: true` — model output could not be parsed as JSON at all.

   These are currently indistinguishable in the report ("No structured entities" covers both), which
   is exactly how this bug went unnoticed. Surface a distinct error state for the second case.

2. **Add a defensive parse step** that strips common wrapper patterns before calling `JSON.parse`:
   - Leading/trailing ```` ``` ```` or ```` ```json ```` fences
   - Any `<think>...</think>` block or similar reasoning tags
   - Leading prose before the first `{` / trailing prose after the last `}`

   This should be a shared utility used by both the dialect-normalize call and the extraction call,
   since both rely on structured output.

3. **Prefer structured output enforcement over prompt instructions alone**, if the provider/model
   supports it (`response_format: json_object`, JSON grammar constraints, or function-calling /
   tool-call style output instead of free-text JSON). Prompt instructions like "respond with only
   JSON" are a request, not a guarantee — grammar-level enforcement is a guarantee.

4. **Log model + provider + raw output on every extraction, success or failure**, tagged to the
   `call_extractions.model_used` field that's already tracked. This turns "it silently returned
   nothing" into "here's exactly why," and gives you the data to compare Qwen3-8B vs Qwen3-32B
   reliability empirically instead of by impression.

## Verification

- [ ] Re-run extraction on this exact case with the raw-output logging in place.
- [ ] Confirm whether the failure is hypothesis 1, 2, or 3.
- [ ] After the fix, re-run 5x and confirm consistent non-empty extraction on this known-good input.
- [ ] Re-run the same fix against `qwen3-8b` too — if 8B was "accidentally" working only because its
      output happened not to trigger the parsing bug, this needs to be fixed there as well, not just
      patched around for 32B.

## Note on testing via OpenRouter specifically

This is fine for model comparison during evaluation, but remember `ARCHITECTURE.md` §12 states
Anusandhan production paths must not call public cloud AI APIs. Once the underlying bug here is
fixed and a model is chosen, re-verify behavior against your **self-hosted ModelForge** deployment
before considering this closed — a locally pinned `llama-server` instance with a fixed quantization
is also more likely to give consistent output formatting than an OpenRouter-routed request that may
hit a different backend provider on any given call, which is itself a contributing factor to
hypothesis 2 above.
