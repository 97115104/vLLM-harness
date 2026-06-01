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

// Validate API key — returns OpenAI-format errors
chat.use("/*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const raw    = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!raw) return openaiError("No API key provided.", "invalid_request_error", "missing_api_key", 401);

  const hash = createHash("sha256").update(raw).digest("hex");
  const key  = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hash) as ApiKey | undefined;
  if (!key || !key.active)
    return openaiError("Invalid API key. Generate one at /admin → Keys.", "invalid_request_error", "invalid_api_key", 401);

  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);
  c.set("apiKey", key);
  await next();
});

// Transparent proxy — forwards all /v1/* to vLLM, captures details for the request log
chat.all("/*", async c => {
  const vllmPath = c.req.path.replace(/^\/v1/, "");
  const method   = c.req.method;
  const key      = c.get("apiKey") as ApiKey;
  const t0       = Date.now();

  // Parse body for POST requests
  let parsedBody: Record<string, unknown> | undefined;
  let rawBody: ArrayBuffer | undefined;

  if (method !== "GET" && method !== "HEAD") {
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      parsedBody = await c.req.json<Record<string, unknown>>().catch(() => undefined);
    }
    if (!parsedBody) rawBody = await c.req.arrayBuffer();
  }

  const isChatCompletion   = vllmPath === "/chat/completions" && method === "POST";
  const isLegacyCompletion = vllmPath === "/completions"       && method === "POST";

  // Build log row for inference requests
  let requestId: string | undefined;
  let promptFull: string | undefined;

  if ((isChatCompletion || isLegacyCompletion) && parsedBody) {
    const model = String(parsedBody.model ?? "unknown");
    let promptPreview = "";

    if (isChatCompletion) {
      const msgs = (parsedBody.messages as { role?: string; content?: unknown }[] | undefined) ?? [];
      const lastUser = [...msgs].reverse().find(m => m.role === "user" || m.role === "assistant");
      promptFull    = msgs.map(m => `[${m.role}] ${String(m.content ?? "")}`).join("\n\n");
      promptPreview = String(lastUser?.content ?? "").slice(0, 200);
    } else {
      promptFull    = String(parsedBody.prompt ?? "");
      promptPreview = promptFull.slice(0, 200);
    }

    const row = db.prepare(
      "INSERT INTO requests (api_key_id, model, status, prompt_preview, prompt_full) VALUES (?,?,'pending',?,?) RETURNING id"
    ).get(key.id, model, promptPreview, promptFull ?? null) as { id: string } | undefined;
    requestId = row?.id;
  }

  try {
    const bodyPayload = parsedBody !== undefined
      ? JSON.stringify(parsedBody)
      : (rawBody as BodyInit | undefined);

    const upstream = await fetch(`${VLLM_URL}/v1${vllmPath}`, {
      method,
      headers: { "content-type": "application/json", "accept": "*/*" },
      body: bodyPayload,
    });

    const isStream  = parsedBody?.stream === true;
    const latencyMs = Date.now() - t0;

    if (requestId) {
      if (!upstream.ok) {
        db.prepare("UPDATE requests SET status='failed', latency_ms=?, error=? WHERE id=?")
          .run(latencyMs, `HTTP ${upstream.status}`, requestId);
      } else if (isStream) {
        // Stream: tee the body so we can accumulate content while forwarding
        const [clientStream, logStream] = upstream.body!.tee();

        // Accumulate in background
        const rid = requestId;
        (async () => {
          const reader = logStream.getReader();
          const dec    = new TextDecoder();
          let content  = "";
          let tOut     = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const text = dec.decode(value, { stream: true });
              for (const line of text.split("\n")) {
                if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
                try {
                  const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string }; finish_reason?: string }[]; usage?: { completion_tokens?: number } };
                  content += chunk.choices?.[0]?.delta?.content ?? "";
                  if (chunk.usage?.completion_tokens) tOut = chunk.usage.completion_tokens;
                } catch { /* skip */ }
              }
            }
          } catch { /* stream ended */ }
          db.prepare("UPDATE requests SET status='completed', latency_ms=?, response_content=?, tokens_out=? WHERE id=?")
            .run(Date.now() - t0, content || null, tOut || null, rid);
        })();

        const responseHeaders: Record<string, string> = {};
        upstream.headers.forEach((v, k) => {
          if (!["transfer-encoding", "connection", "keep-alive"].includes(k.toLowerCase()))
            responseHeaders[k] = v;
        });
        return new Response(clientStream, { status: upstream.status, headers: responseHeaders });

      } else {
        // Non-streaming: clone body to capture response
        const cloned = upstream.clone();
        (cloned.json() as Promise<{ choices?: { message?: { content?: string }; text?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>)
          .then(body => {
            const responseContent = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? null;
            db.prepare("UPDATE requests SET status='completed', latency_ms=?, tokens_in=?, tokens_out=?, response_content=? WHERE id=?")
              .run(latencyMs, body.usage?.prompt_tokens ?? null, body.usage?.completion_tokens ?? null, responseContent, requestId);
          })
          .catch(() => {
            db.prepare("UPDATE requests SET status='completed', latency_ms=? WHERE id=?").run(latencyMs, requestId);
          });
      }
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!["transfer-encoding", "connection", "keep-alive"].includes(k.toLowerCase()))
        responseHeaders[k] = v;
    });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });

  } catch (e) {
    if (requestId) {
      db.prepare("UPDATE requests SET status='failed', error=? WHERE id=?")
        .run(e instanceof Error ? e.message : String(e), requestId);
    }
    return openaiError("The inference engine is unavailable. Is a model deployed?", "server_error", "engine_unavailable", 503);
  }
});

export { chat };
