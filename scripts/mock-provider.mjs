#!/usr/bin/env node
/**
 * Mock OpenAI-compatible provider for PolyLab development/demo runs.
 * Speaks the subset of the API that polylab-core uses: GET /v1/models and
 * POST /v1/chat/completions with SSE streaming (reasoning_content + <think> tags).
 *
 *   node scripts/mock-provider.mjs          # 127.0.0.1:4999
 *   PORT=5000 node scripts/mock-provider.mjs
 */
import http from "node:http";

const port = Number(process.env.PORT || 4999);

const MODELS = [
  { id: "mock-fast", display_name: "Mock Fast" },
  { id: "mock-thinker", display_name: "Mock Thinker (native reasoning)" },
  { id: "mock-tagged", display_name: "Mock Tagged (<think> stream)" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sse(res, object) {
  res.write(`data: ${JSON.stringify(object)}\n\n`);
}

function tokenChunks(text, size = 6) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [""];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: MODELS }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => resolve(JSON.parse(raw || "{}")));
    });

    const model = body.model ?? "mock-fast";
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const question = String(lastUser?.content ?? "").slice(0, 160);
    const answer =
      `**${model}** yanıtlıyor:\n\n` +
      `> ${question || "(boş)"}\n\n` +
      `Bu yanıt yerel **mock sağlayıcıdan** geliyor (${new Date().toLocaleTimeString()}). ` +
      `PolyLab'in akış, reasoning ve token sayaçlarını bu uç üzerinde deneyebilirsiniz.`;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // native reasoning (deepseek-style)
    if (model.includes("thinker")) {
      const reasoning = "Soru: " + (question || "—") + "\nAdım 1: isteği anla. Adım 2: kısa bir yanıt kur. Adım 3: biçimle.";
      for (const chunk of tokenChunks(reasoning, 9)) {
        sse(res, { choices: [{ delta: { reasoning_content: chunk } }] });
        await sleep(30);
      }
    }

    // inline <think> tags (qwen-style), split across chunk borders on purpose
    if (model.includes("tagged")) {
      const secret = "Nihai cevabı iki cümlede vereyim, madde gerekmez.";
      const pieces = ["<th", "ink>", secret, "</th", "ink>"];
      let buffer = "";
      for (const piece of pieces) {
        buffer += piece;
        sse(res, { choices: [{ delta: { content: piece } }] });
        await sleep(40);
      }
    }

    for (const chunk of tokenChunks(answer, 7)) {
      sse(res, { choices: [{ delta: { content: chunk } }] });
      await sleep(25);
    }

    const tokensIn = Math.ceil((body.messages ?? []).reduce((n, m) => n + String(m.content ?? "").length, 0) / 4);
    sse(res, { choices: [], usage: { prompt_tokens: tokensIn, completion_tokens: Math.ceil(answer.length / 4) } });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-provider] listening on http://127.0.0.1:${port}/v1 (${MODELS.length} models)`);
});
