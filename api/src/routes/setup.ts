import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { adminAuth, type HonoVars } from "../middleware/auth.js";
import { deployModel, stopVllm, getVllmStatus, vllmLogs } from "../lib/docker.js";
import db from "../db/index.js";

const VLLM_URL = process.env.VLLM_URL || "http://localhost:8000";

export const MODELS = [
  {
    id: "mistralai/Mistral-7B-Instruct-v0.3",
    name: "Mistral 7B Instruct",
    description: "Fast, capable chat model from Mistral AI",
    params: "7B", vram_gb: 14, vram_int8_gb: 7, context_k: 32,
    tags: ["general", "chat", "coding"],
    no_auth: true,
  },
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    name: "Qwen 2.5 7B",
    description: "Alibaba's excellent multilingual model with long context",
    params: "7B", vram_gb: 14, vram_int8_gb: 7, context_k: 128,
    tags: ["multilingual", "long-context"],
    no_auth: true,
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B",
    description: "OpenAI's open-source reasoning model — strong at logic and math",
    params: "20B", vram_gb: 40, vram_int8_gb: 20, context_k: 16,
    tags: ["reasoning", "math"],
    no_auth: true,
  },
  {
    id: "microsoft/Phi-4-mini-instruct",
    name: "Phi-4 Mini",
    description: "Microsoft's compact but highly capable instruction model",
    params: "3.8B", vram_gb: 8, vram_int8_gb: 4, context_k: 128,
    tags: ["efficient", "coding"],
    no_auth: true,
  },
  {
    id: "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
    name: "TinyLlama 1.1B",
    description: "Smallest option — runs on nearly any hardware",
    params: "1.1B", vram_gb: 2, vram_int8_gb: 1, context_k: 2,
    tags: ["lightweight", "fast"],
    no_auth: true,
  },
  // More models
  {
    id: "Qwen/Qwen2.5-14B-Instruct",
    name: "Qwen 2.5 14B",
    description: "More capable Qwen with 128K context",
    params: "14B", vram_gb: 28, vram_int8_gb: 14, context_k: 128,
    tags: ["multilingual", "large"],
    no_auth: true,
  },
  {
    id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    name: "DeepSeek R1 7B",
    description: "Strong reasoning via distillation of DeepSeek R1",
    params: "7B", vram_gb: 14, vram_int8_gb: 7, context_k: 128,
    tags: ["reasoning", "distill"],
    no_auth: true,
  },
  {
    id: "microsoft/Phi-3.5-mini-instruct",
    name: "Phi-3.5 Mini",
    description: "Compact model with 128K context window",
    params: "3.8B", vram_gb: 8, vram_int8_gb: 4, context_k: 128,
    tags: ["efficient"],
    no_auth: true,
  },
  {
    id: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
    name: "SmolLM2 1.7B",
    description: "Ultra-lightweight, great for testing",
    params: "1.7B", vram_gb: 4, vram_int8_gb: 2, context_k: 8,
    tags: ["lightweight"],
    no_auth: true,
  },
  {
    id: "meta-llama/Llama-3.1-8B-Instruct",
    name: "Llama 3.1 8B",
    description: "Meta's flagship small model (requires HF token)",
    params: "8B", vram_gb: 16, vram_int8_gb: 8, context_k: 128,
    tags: ["general", "popular"],
    no_auth: false,
  },
  {
    id: "meta-llama/Llama-3.2-3B-Instruct",
    name: "Llama 3.2 3B",
    description: "Meta's compact multilingual model (requires HF token)",
    params: "3B", vram_gb: 6, vram_int8_gb: 3, context_k: 128,
    tags: ["compact"],
    no_auth: false,
  },
  {
    id: "Qwen/QwQ-32B",
    name: "QwQ 32B",
    description: "Very strong reasoning, large model",
    params: "32B", vram_gb: 64, vram_int8_gb: 32, context_k: 128,
    tags: ["reasoning", "large"],
    no_auth: true,
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    description: "OpenAI's large open-source model — requires multi-GPU",
    params: "120B", vram_gb: 240, vram_int8_gb: 120, context_k: 16,
    tags: ["reasoning", "large", "multi-gpu"],
    no_auth: true,
  },
];

const setup = new Hono<HonoVars>();

setup.get("/status", async c => {
  const status = getVllmStatus();

  // Also check vLLM health endpoint if "running"
  if (status.status === "running") {
    try {
      const res = await fetch(`${VLLM_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) {
        return c.json({ ...status, status: "error", error: "vLLM health check failed" });
      }
    } catch {
      return c.json({ ...status, status: "error", error: "vLLM unreachable" });
    }
  }

  const tunnelUrl = db.prepare("SELECT value FROM settings WHERE key = 'tunnel_url'").get() as { value: string } | undefined;
  return c.json({ ...status, tunnel_url: tunnelUrl?.value ?? null });
});

setup.get("/models", c => c.json({ models: MODELS }));

setup.post("/deploy", adminAuth, async c => {
  const body = await c.req.json<{ model?: string; hf_token?: string }>().catch(() => ({}));
  if (!body.model) return c.json({ error: "model is required" }, 400);

  const found = MODELS.find(m => m.id === body.model);
  if (!found) return c.json({ error: "Unknown model" }, 400);

  if (!found.no_auth && !body.hf_token) {
    return c.json({ error: "This model requires a Hugging Face token", needs_hf_token: true }, 400);
  }

  if (body.hf_token) {
    process.env.HF_TOKEN = body.hf_token;
  }

  // Fire off deployment in background
  deployModel(body.model).catch(err => {
    console.error("Deploy error:", err);
  });

  return c.json({ ok: true, message: "Deployment started", model: body.model });
});

setup.post("/stop", adminAuth, async c => {
  await stopVllm();
  return c.json({ ok: true });
});

setup.get("/logs", adminAuth, c => {
  return streamSSE(c, async stream => {
    for await (const line of vllmLogs(200)) {
      await stream.writeSSE({ data: JSON.stringify({ line }) });
    }
  });
});

setup.post("/tunnel", adminAuth, async c => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({}));
  if (!body.url) return c.json({ error: "url required" }, 400);
  db.prepare("INSERT INTO settings (key, value) VALUES ('tunnel_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(body.url);
  return c.json({ ok: true });
});

export { setup };
