import { performance } from "node:perf_hooks";
import OpenAI from "openai";

const apiKey = process.env.MODELFORGE_API_KEY;
if (!apiKey) throw new Error("Set MODELFORGE_API_KEY");

const client = new OpenAI({
  apiKey,
  baseURL: process.env.MODELFORGE_BASE_URL ?? "http://localhost:9000/v1",
});
const model = process.env.MODELFORGE_TEST_MODEL ?? "zms-coder-7b";
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 2);
const requests = Number(process.env.BENCH_REQUESTS ?? 6);

async function runOne(index) {
  const started = performance.now();
  const result = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: `Count from one to ten. Request ${index}.` }],
    max_tokens: 64,
  });
  const elapsedMs = performance.now() - started;
  return {
    elapsedMs,
    outputTokens: result.usage?.completion_tokens ?? 0,
  };
}

const results = [];
for (let offset = 0; offset < requests; offset += concurrency) {
  results.push(
    ...(await Promise.all(
      Array.from(
        { length: Math.min(concurrency, requests - offset) },
        (_, i) => runOne(offset + i),
      ),
    )),
  );
}

const totalMs = results.reduce((sum, item) => sum + item.elapsedMs, 0);
const totalTokens = results.reduce((sum, item) => sum + item.outputTokens, 0);
console.log(
  JSON.stringify(
    {
      model,
      requests,
      concurrency,
      avgLatencyMs: Math.round(totalMs / results.length),
      aggregateTokensPerSecond: Number((totalTokens / (totalMs / 1000)).toFixed(2)),
      results,
    },
    null,
    2,
  ),
);
