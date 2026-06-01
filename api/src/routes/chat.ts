import { Hono } from "hono";
import { apiKeyAuth, type HonoVars } from "../middleware/auth.js";
import db from "../db/index.js";
import type { ApiKey } from "../db/index.js";

const VLLM_URL = process.env.VLLM_URL || "http://inference-studio-vllm:8000";

const chat = new Hono<HonoVars>();

chat.use("/*", apiKeyAuth);

// Proxy all /v1/* to vLLM, log chat completions
chat.all("/*", async c => {
  const vllmPath  = c.req.path.replace(/^\/v1/, "");
  const method    = c.req.method;
  const key       = c.get("apiKey") as ApiKey;
  const startTime = Date.now();
  let requestId: string | undefined;

  const isChatCompletion = vllmPath === "/chat/completions" && method === "POST";
  let parsedBody: unknown;
  let promptPreview: string | undefined;

  if (isChatCompletion) {
    try {
      parsedBody = await c.req.json();
      const msgs = (parsedBody as { messages?: { content?: string }[] }).messages ?? [];
      const lastUser = [...msgs].reverse().find(m => m)?.content ?? "";
      promptPreview = String(lastUser).slice(0, 200);
    } catch { /* malformed body — pass through as-is */ }

    // Insert request log row, extract id string (not the row object)
    const row = db.prepare(
      "INSERT INTO requests (api_key_id, model, status, prompt_preview) VALUES (?, ?, 'pending', ?) RETURNING id"
    ).get(
      key.id,
      (parsedBody as { model?: string })?.model ?? "unknown",
      promptPreview ?? null
    ) as { id: string } | undefined;
    requestId = row?.id;
  }

  try {
    // Minimal headers — lowercase keys to avoid duplicates
    const fwdHeaders: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    };

    // Use parsed body for JSON requests; otherwise forward raw bytes
    let bodyPayload: BodyInit | undefined;
    if (parsedBody !== undefined) {
      bodyPayload = JSON.stringify(parsedBody);
    } else if (method !== "GET" && method !== "HEAD") {
      bodyPayload = await c.req.arrayBuffer();
    }

    const upstream = await fetch(`${VLLM_URL}/v1${vllmPath}`, {
      method,
      headers: fwdHeaders,
      body: bodyPayload,
    });

    // Update request log
    if (isChatCompletion && requestId) {
      const latencyMs = Date.now() - startTime;
      if (!upstream.ok) {
        db.prepare("UPDATE requests SET status='failed', latency_ms=?, error=? WHERE id=?")
          .run(latencyMs, `HTTP ${upstream.status}`, requestId);
      } else {
        db.prepare("UPDATE requests SET status='completed', latency_ms=? WHERE id=?")
          .run(latencyMs, requestId);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
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
    return c.json(
      { error: { message: "Inference engine unavailable. Is a model deployed?", type: "server_error" } },
      503
    );
  }
});

export { chat };
