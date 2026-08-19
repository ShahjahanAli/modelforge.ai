import OpenAI from "openai";

const apiKey = process.env.MODELFORGE_API_KEY;
if (!apiKey) {
  throw new Error("Set MODELFORGE_API_KEY to a seeded or dashboard-created API key");
}

const baseURL = process.env.MODELFORGE_BASE_URL ?? "http://localhost:9000/v1";
const model = process.env.MODELFORGE_TEST_MODEL ?? "zms-coder-7b";
const client = new OpenAI({ apiKey, baseURL });

const completion = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Reply with: non-stream-ok" }],
  max_tokens: 32,
});

if (!completion.choices[0]?.message.content) {
  throw new Error("Non-streaming response did not contain assistant content");
}
console.log("non-stream:", completion.choices[0].message.content);

const stream = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Reply with: stream-ok" }],
  max_tokens: 32,
  stream: true,
});

let streamed = "";
for await (const chunk of stream) {
  streamed += chunk.choices[0]?.delta.content ?? "";
}
if (!streamed) {
  throw new Error("Streaming response did not contain assistant content");
}
console.log("stream:", streamed);
console.log("OpenAI SDK compatibility passed");
