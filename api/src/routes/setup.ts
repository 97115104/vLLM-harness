import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { adminAuth, type HonoVars } from "../middleware/auth.js";
import { deployModel, stopVllm, cancelDeployment, getVllmStatus, isDeploymentInProgress, recoverDeploymentIfNeeded, getModelTokenLimits, getTokenLimitsFromModelLen, vllmLogs, getDockerMemoryGb, getCpuRequiredMemoryGb, getCpuMemoryEstimate, syncVllmStatusIfReady, syncDeployStateFromContainer, modelFitsDockerCpu, getDockerMemoryForVllmGb, DOCKER_STUDIO_OVERHEAD_GB } from "../lib/docker.js";
import db from "../db/index.js";

const VLLM_URL = process.env.VLLM_URL || "http://inference-studio-vllm:8000";

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

const GPU_TYPE = (process.env.GPU_TYPE || "cpu") as "nvidia" | "metal" | "cpu";

function enrichModel<T extends { context_k: number }>(model: T) {
  return { ...model, ...getModelTokenLimits(model.context_k, GPU_TYPE) };
}

function enrichStatus<T extends { model: string | null; max_model_len?: string | null }>(status: T) {
  const catalog = status.model ? MODELS.find(m => m.id === status.model) : undefined;
  if (catalog) return { ...status, ...getModelTokenLimits(catalog.context_k, GPU_TYPE) };
  const len = Number(status.max_model_len);
  if (len > 0) return { ...status, max_model_len: len, ...getTokenLimitsFromModelLen(len) };
  return status;
}

const setup = new Hono<HonoVars>();

setup.get("/status", async c => {
  await syncDeployStateFromContainer();
  await syncVllmStatusIfReady();
  const status = getVllmStatus();
  const dockerMemGb = GPU_TYPE !== "nvidia" ? await getDockerMemoryGb() : null;
  const withMem = dockerMemGb != null ? { ...status, docker_memory_gb: Math.round(dockerMemGb * 10) / 10 } : status;

  if (status.status === "running" && status.model) {
    const healthy = await (async () => {
      try {
        const res = await fetch(`${VLLM_URL}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    })();

    if (!healthy) {
      void recoverDeploymentIfNeeded();
      const updated = getVllmStatus();
      const tunnelUrl = db.prepare("SELECT value FROM settings WHERE key = 'tunnel_url'").get() as { value: string } | undefined;
      return c.json({
        ...enrichStatus(updated),
        ...(dockerMemGb != null ? { docker_memory_gb: Math.round(dockerMemGb * 10) / 10 } : {}),
        status: updated.status === "running" ? "starting" : updated.status,
        error: "",
        progress: updated.progress || "Restarting vLLM after service restart…",
        tunnel_url: tunnelUrl?.value ?? null,
      });
    }
  }

  const tunnelUrl = db.prepare("SELECT value FROM settings WHERE key = 'tunnel_url'").get() as { value: string } | undefined;
  return c.json({ ...enrichStatus(withMem), tunnel_url: tunnelUrl?.value ?? null });
});

setup.get("/models", async c => {
  const dockerMemGb = GPU_TYPE !== "nvidia" ? await getDockerMemoryGb() : null;
  const vllmMemGb = dockerMemGb != null ? getDockerMemoryForVllmGb(dockerMemGb) : null;
  const models = MODELS.map(m => {
    const enriched = enrichModel(m);
    if (dockerMemGb == null) return enriched;
    const requiredGb = getCpuRequiredMemoryGb(m.params, m.vram_gb);
    return {
      ...enriched,
      cpu_required_gb: requiredGb,
      fits_cpu: modelFitsDockerCpu(dockerMemGb, m.params, m.vram_gb),
    };
  });
  return c.json({
    models,
    ...(dockerMemGb != null ? {
      docker_memory_gb: Math.round(dockerMemGb * 10) / 10,
      docker_vllm_memory_gb: Math.round(vllmMemGb! * 10) / 10,
      docker_studio_overhead_gb: DOCKER_STUDIO_OVERHEAD_GB,
    } : {}),
  });
});

setup.post("/deploy", adminAuth, async c => {
  const body: { model?: string; hf_token?: string; replace?: boolean } = await c.req.json<{ model?: string; hf_token?: string; replace?: boolean }>().catch(() => ({}));
  if (!body.model) return c.json({ error: "model is required" }, 400);

  const found = MODELS.find(m => m.id === body.model);
  if (!found) return c.json({ error: "Unknown model" }, 400);

  if (!found.no_auth && !body.hf_token) {
    return c.json({ error: "This model requires a Hugging Face token", needs_hf_token: true }, 400);
  }

  const gpuType = process.env.GPU_TYPE || "cpu";

  if (gpuType !== "nvidia") {
    const dockerMemGb = await getDockerMemoryGb();
    const est = getCpuMemoryEstimate(found.params, found.vram_gb);
    const vllmMemGb = dockerMemGb != null ? getDockerMemoryForVllmGb(dockerMemGb) : null;

    if (dockerMemGb != null && !modelFitsDockerCpu(dockerMemGb, found.params, found.vram_gb)) {
      return c.json({
        error: `${found.name} needs ~${est.totalGb}GB for vLLM (~${est.weightsGb}GB weights + ~${est.overheadGb}GB KV cache/runtime). Docker has ${dockerMemGb.toFixed(1)}GB total (~${vllmMemGb!.toFixed(1)}GB available after ~${DOCKER_STUDIO_OVERHEAD_GB}GB for Inference Studio). Increase Docker memory in Admin → Settings or try a smaller model.`,
      }, 400);
    }
  }

  if (isDeploymentInProgress()) {
    if (!body.replace) {
      return c.json({ error: "A deployment is already in progress", in_progress: true }, 409);
    }
    await cancelDeployment();
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

setup.post("/cancel", adminAuth, async c => {
  await cancelDeployment();
  return c.json({ ok: true });
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
  const body: { url?: string } = await c.req.json<{ url?: string }>().catch(() => ({}));
  if (!body.url) return c.json({ error: "url required" }, 400);
  db.prepare("INSERT INTO settings (key, value) VALUES ('tunnel_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(body.url);
  return c.json({ ok: true });
});

export { setup };
