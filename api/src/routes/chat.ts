import { Hono } from "hono";
import { createHash } from "crypto";
import db from "../db/index.js";
import type { ApiKey } from "../db/index.js";
import type { HonoVars } from "../middleware/auth.js";

const VLLM_URL = process.env.VLLM_URL || "http://inference-studio-vllm:8000";

const chat = new Hono<HonoVars>();

// OpenAI-compatible error helper
const openaiError = (message: string, type = "server_error", code: string | null = null, status = 500) =>
  Response.json({ error: { message, type, param: null, code } }, { status });

// Validate API key inline (OpenAI-format errors on failure)
chat.use("/*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const raw    = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!raw) {
    return openaiError(
      "No API key provided. Pass it in Authorization: Bearer <key>",
      "invalid_request_error",
      "missing_api_key",
      401
    );
  }

  const hash = createHash("sha256").update(raw).digest("hex");
  const key  = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hash) as ApiKey | undefined;

  if (!key || !key.active) {
    return openaiError(
      "Invalid API key. Generate one at /admin → Keys.",
      "invalid_request_error",
      "invalid_api_key",
      401
    );
  }

  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);
  c.set("apiKey", key);
  await next();
});

// Transparent proxy — forwards all /v1/* to vLLM with logging for chat completions
chat.all("/*", async c => {
  const vllmPath = c.req.path.replace(/^\/v1/, "");
  const method   = c.req.method;
  const key      = c.get("apiKey") as ApiKey;
  const t0       = Date.now();

  // Parse body once for POST requests so we can log and re-send
  let parsedBody: Record<string, unknown> | undefined;
  let rawBody: ArrayBuffer | undefined;

  if (method !== "GET" && method !== "HEAD") {
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      parsedBody = await c.req.json<Record<string, unknown>>().catch(() => undefined);
    }
    if (!parsedBody) {
      rawBody = await c.req.arrayBuffer();
    }
  }

  const isChatCompletion  = vllmPath === "/chat/completions"  && method === "POST";
  const isLegacyCompletion = vllmPath === "/completions"       && method === "POST";
  const isEmbedding       = vllmPath === "/embeddings"         && method === "POST";

  // Insert log row for inference requests
  let requestId: string | undefined;
  if ((isChatCompletion || isLegacyCompletion) && parsedBody) {
    const model = String(parsedBody.model ?? "unknown");
    let promptPreview: string | undefined;

    if (isChatCompletion) {
      const msgs = (parsedBody.messages as { content?: unknown }[] | undefined) ?? [];
      const lastUser = [...msgs].reverse().find(m => m)?.content;
      promptPreview = String(lastUser ?? "").slice(0, 200);
    } else {
      promptPreview = String(parsedBody.prompt ?? "").slice(0, 200);
    }

    const row = db.prepare(
      "INSERT INTO requests (api_key_id, model, status, prompt_preview) VALUES (?,?,'pending',?) RETURNING id"
    ).get(key.id, model, promptPreview ?? null) as { id: string } | undefined;
    requestId = row?.id;
  }

  try {
    const bodyPayload = parsedBody !== undefined
      ? JSON.stringify(parsedBody)
      : rawBody;

    const upstream = await fetch(`${VLLM_URL}/v1${vllmPath}`, {
      method,
      headers: { "content-type": "application/json", "accept": "*/*" },
      body: bodyPayload as BodyInit | undefined,
    });

    // Log token usage from non-streaming responses
    if (requestId && upstream.ok) {
      const isStream = parsedBody?.stream === true;
      const latencyMs = Date.now() - t0;

      if (!isStream) {
        // Clone so we can read body AND still stream it to client
        const cloned = upstream.clone();
        cloned.json<{ usage?: { prompt_tokens?: number; completion_tokens?: number } }>()
          .then(body => {
            db.prepare(
              "UPDATE requests SET status='completed', latency_ms=?, tokens_in=?, tokens_out=? WHERE id=?"
            ).run(
              latencyMs,
              body.usage?.prompt_tokens ?? null,
              body.usage?.completion_tokens ?? null,
              requestId
            );
          })
          .catch(() => {
            db.prepare("UPDATE requests SET status='completed', latency_ms=? WHERE id=?")
              .run(latencyMs, requestId);
          });
      } else {
        db.prepare("UPDATE requests SET status='completed', latency_ms=? WHERE id=?")
          .run(latencyMs, requestId);
      }
    } else if (requestId && !upstream.ok) {
      db.prepare("UPDATE requests SET status='failed', latency_ms=?, error=? WHERE id=?")
        .run(Date.now() - t0, `HTTP ${upstream.status}`, requestId);
    }

    // Pass response through verbatim — preserve all headers and body
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (!["transfer-encoding", "connection", "keep-alive"].includes(lk)) {
        responseHeaders[k] = v;
      }
    });

    return new Response(upstream.body, {
      status:  upstream.status,
      headers: responseHeaders,
    });

  } catch (e) {
    if (requestId) {
      db.prepare("UPDATE requests SET status='failed', error=? WHERE id=?")
        .run(e instanceof Error ? e.message : String(e), requestId);
    }
    return openaiError(
      "The inference engine is unavailable. Is a model deployed?",
      "server_error",
      "engine_unavailable",
      503
    );
  }
});

export { chat };
