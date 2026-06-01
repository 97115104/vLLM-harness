import { Hono } from "hono";
import { apiKeyAuth, type HonoVars } from "../middleware/auth.js";
import db from "../db/index.js";
import type { ApiKey } from "../db/index.js";

const VLLM_URL = process.env.VLLM_URL || "http://localhost:8000";

const chat = new Hono<HonoVars>();

// All /v1/* routes require API key
chat.use("/*", apiKeyAuth);

// Proxy to vLLM — OpenAI-compatible
chat.all("/*", async c => {
  const path      = c.req.path.replace(/^\/v1/, "");
  const method    = c.req.method;
  const key       = c.get("apiKey") as ApiKey;
  const startTime = Date.now();
  let requestId: string | undefined;

  // For chat completions, log the request
  const isChatCompletion = path === "/chat/completions" && method === "POST";
  let body: unknown;
  let promptPreview: string | undefined;

  if (isChatCompletion) {
    try {
      body = await c.req.json();
      const msgs = (body as { messages?: { content?: string }[] }).messages ?? [];
      const lastUser = msgs.filter(m => m).reverse().find(m => m)?.content ?? "";
      promptPreview = String(lastUser).slice(0, 200);
    } catch { body = undefined; }

    requestId = db
      .prepare("INSERT INTO requests (api_key_id, model, status, prompt_preview) VALUES (?, ?, 'pending', ?) RETURNING id")
      .get(key.id, (body as { model?: string })?.model ?? "unknown", promptPreview ?? null) as { id: string } | undefined;
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    c.req.raw.headers.forEach((v, k) => {
      if (!["host", "authorization", "content-length"].includes(k.toLowerCase())) headers[k] = v;
    });

    const upstream = await fetch(`${VLLM_URL}/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : (method === "GET" ? undefined : await c.req.arrayBuffer()),
      // @ts-ignore — node-fetch / undici duplex
      duplex: "half",
    });

    if (isChatCompletion && requestId) {
      const latencyMs = Date.now() - startTime;
      if (!upstream.ok) {
        db.prepare("UPDATE requests SET status='failed', latency_ms=?, error=? WHERE id=?")
          .run(latencyMs, `HTTP ${upstream.status}`, requestId);
      } else {
        const isStream = String(body && (body as { stream?: boolean }).stream);
        if (isStream === "true") {
          // Streaming: update as completed after first chunk
          db.prepare("UPDATE requests SET status='completed', latency_ms=? WHERE id=?").run(latencyMs, requestId);
        }
      }
    }

    // Stream the response back
    return new Response(upstream.body, {
      status:  upstream.status,
      headers: Object.fromEntries(
        [...upstream.headers.entries()].filter(([k]) =>
          !["transfer-encoding", "connection"].includes(k.toLowerCase())
        )
      ),
    });
  } catch (e) {
    if (requestId) {
      db.prepare("UPDATE requests SET status='failed', error=? WHERE id=?")
        .run(e instanceof Error ? e.message : String(e), requestId);
    }
    return c.json({ error: { message: "vLLM unavailable. Is a model deployed?", type: "server_error" } }, 503);
  }
});

export { chat };
