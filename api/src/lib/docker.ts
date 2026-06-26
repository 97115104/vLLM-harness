import Dockerode from "dockerode";
import db from "../db/index.js";

export const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export const VLLM_CONTAINER_NAME = "inference-studio-vllm";
export const VLLM_PORT           = Number(process.env.VLLM_PORT ?? 8000);
export const VLLM_NETWORK        = process.env.DOCKER_NETWORK || "inference-studio_default";
const VLLM_URL                   = process.env.VLLM_URL || `http://inference-studio-vllm:${VLLM_PORT}`;

// GPU_TYPE from deploy-locally.sh: "nvidia" | "metal" | "cpu"
// nvidia → vllm-openai:latest with NVIDIA DeviceRequests
// metal/cpu → vllm-openai-cpu image (Docker cannot use Apple Metal)
const GPU_TYPE_ENV = (process.env.GPU_TYPE || "cpu") as "nvidia" | "metal" | "cpu";

function getCpuArchSuffix(): "arm64" | "x86_64" {
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

/** Docker image for the current hardware backend. Override with VLLM_IMAGE. */
export function getVllmImage(gpuType: "nvidia" | "metal" | "cpu" = GPU_TYPE_ENV): string {
  if (process.env.VLLM_IMAGE) return process.env.VLLM_IMAGE;
  if (gpuType === "nvidia") return "vllm/vllm-openai:latest";
  return `vllm/vllm-openai-cpu:latest-${getCpuArchSuffix()}`;
}

function usesCpuBackend(gpuType: "nvidia" | "metal" | "cpu"): boolean {
  return gpuType !== "nvidia";
}

export const TOKEN_OUTPUT_HEADROOM = 256;
export const TOKEN_MIN_OUTPUT = 64;

let cachedDockerMemGb: number | null | undefined;

/** Clear cached Docker memory (call after changing Docker Desktop memory limits). */
export function clearDockerMemoryCache(): void {
  cachedDockerMemGb = undefined;
}

/** RAM reserved for api, web, and load spikes — not available to the vLLM container. */
export const DOCKER_STUDIO_OVERHEAD_GB = 2;

/** Docker memory available for the vLLM container after studio services. */
export function getDockerMemoryForVllmGb(dockerMemGb: number): number {
  return Math.max(0, dockerMemGb - DOCKER_STUDIO_OVERHEAD_GB);
}

export function modelFitsDockerCpu(dockerMemGb: number, params: string, vramGbFallback: number): boolean {
  const requiredGb = getCpuRequiredMemoryGb(params, vramGbFallback);
  return getDockerMemoryForVllmGb(dockerMemGb) >= requiredGb;
}

/** Parse catalog params string (e.g. "3.8B", "1.1B") to billions of parameters. */
export function parseParamsBillions(params: string): number {
  const m = params.match(/([\d.]+)\s*B/i);
  return m ? parseFloat(m[1]) : 0;
}

/** CPU memory breakdown for a model (matches runVllmContainer --dtype and VLLM_CPU_KVCACHE_SPACE=1). */
export function getCpuMemoryEstimate(params: string, vramGbFallback: number) {
  const billions = parseParamsBillions(params);
  let weightsGb: number;
  if (billions > 0) {
    const bytesPerParam = process.arch === "arm64" ? 2 : 4;
    // Small margin for embeddings / output head beyond raw param count
    weightsGb = (billions * 1e9 * bytesPerParam * 1.05) / (1024 ** 3);
  } else {
    weightsGb = vramGbFallback;
  }
  const kvCacheGb = 1; // VLLM_CPU_KVCACHE_SPACE=1
  const runtimeGb = Math.max(0.5, Math.min(1.5, weightsGb * 0.1));
  const totalGb = Math.ceil((weightsGb + kvCacheGb + runtimeGb) * 10) / 10;
  return {
    weightsGb: Math.round(weightsGb * 10) / 10,
    overheadGb: Math.round((kvCacheGb + runtimeGb) * 10) / 10,
    totalGb,
  };
}

export function getCpuRequiredMemoryGb(params: string, vramGbFallback: number): number {
  return getCpuMemoryEstimate(params, vramGbFallback).totalGb;
}

/** Docker daemon memory limit in GB (Docker Desktop → Settings → Resources). */
export async function getDockerMemoryGb(): Promise<number | null> {
  if (cachedDockerMemGb !== undefined) return cachedDockerMemGb;
  try {
    const info = await docker.info();
    const bytes = info.MemTotal ?? 0;
    cachedDockerMemGb = bytes > 0 ? bytes / (1024 ** 3) : null;
    return cachedDockerMemGb;
  } catch {
    cachedDockerMemGb = null;
    return null;
  }
}

/** vLLM --max-model-len for the current hardware backend. */
export function getDeploymentMaxModelLen(gpuType: "nvidia" | "metal" | "cpu" = GPU_TYPE_ENV): number {
  return gpuType === "nvidia" ? 4096 : 1024;
}

/** Effective input/output caps for a catalog model on this machine. */
export function getModelTokenLimits(
  contextK: number,
  gpuType: "nvidia" | "metal" | "cpu" = GPU_TYPE_ENV,
) {
  const nativeMax = contextK * 1000;
  const maxModelLen = Math.min(nativeMax, getDeploymentMaxModelLen(gpuType));
  const maxOutputTokens = Math.max(TOKEN_MIN_OUTPUT, maxModelLen - TOKEN_OUTPUT_HEADROOM);
  const maxInputTokens = maxModelLen - TOKEN_MIN_OUTPUT;
  return { max_model_len: maxModelLen, max_input_tokens: maxInputTokens, max_output_tokens: maxOutputTokens };
}

export function getTokenLimitsFromModelLen(maxModelLen: number) {
  const maxOutputTokens = Math.max(TOKEN_MIN_OUTPUT, maxModelLen - TOKEN_OUTPUT_HEADROOM);
  const maxInputTokens = maxModelLen - TOKEN_MIN_OUTPUT;
  return { max_input_tokens: maxInputTokens, max_output_tokens: maxOutputTokens };
}

function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
  ).run(key, value);
}

function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

class DeployCancelledError extends Error {
  constructor() { super("Deployment cancelled"); this.name = "DeployCancelledError"; }
}

let deployGeneration = 0;
let cancelledGeneration = 0;
let activePullStream: NodeJS.ReadableStream | null = null;

function isDeployCancelled(generation: number): boolean {
  return generation <= cancelledGeneration;
}

export function isDeploymentInProgress(): boolean {
  const status = getSetting("vllm_status") || "idle";
  return status === "pulling" || status === "starting";
}

export function getVllmStatus() {
  const status = getSetting("vllm_status") || "idle";
  const startedAt = getSetting("vllm_deploy_started_at");
  const storedPct = Number(getSetting("vllm_progress_pct") || 0);
  const elapsedPct = elapsedDeployPct(status, startedAt);
  const progressPct = ["pulling", "starting"].includes(status)
    ? Math.max(storedPct, elapsedPct ?? 0) || null
    : null;

  return {
    status,
    model:    getSetting("vllm_model"),
    error:    getSetting("vllm_error"),
    progress: getSetting("vllm_progress"),
    activity: getSetting("vllm_activity"),
    recent_log: getSetting("vllm_recent_log"),
    progress_pct: progressPct,
    started_at: startedAt,
    gpu_util: getSetting("vllm_gpu_util"),
    max_model_len: getSetting("vllm_max_model_len"),
    gpu_type: GPU_TYPE_ENV,
  };
}

export async function cancelDeployment(): Promise<void> {
  cancelledGeneration = deployGeneration;
  if (activePullStream) {
    try { (activePullStream as unknown as { destroy(): void }).destroy(); } catch { /* ok */ }
    activePullStream = null;
  }
  await stopVllm();
  clearDeployProgress();
}

export async function stopVllm(): Promise<void> {
  try {
    const c = docker.getContainer(VLLM_CONTAINER_NAME);
    const info = await c.inspect().catch(() => null);
    if (info?.State?.Running) {
      await c.stop({ t: 15 }).catch(() => null);
    }
    await c.remove({ force: true }).catch(() => null);
  } catch { /* already gone */ }
  setSetting("vllm_status", "idle");
  setSetting("vllm_model", "");
  setSetting("vllm_error", "");
  clearDeployProgress();
  setSetting("vllm_max_model_len", "");
}

async function killExistingVllm(): Promise<void> {
  try {
    const c = docker.getContainer(VLLM_CONTAINER_NAME);
    const info = await c.inspect().catch(() => null);
    if (info?.State?.Running) await c.stop({ t: 15 }).catch(() => null);
    await c.remove({ force: true }).catch(() => null);
  } catch { /* nothing running */ }
}

async function runVllmContainer(model: string, gpuUtil: number, gpuType: "nvidia" | "metal" | "cpu"): Promise<Dockerode.Container> {
  await killExistingVllm();

  const cpuBackend = usesCpuBackend(gpuType);
  const image = getVllmImage(gpuType);

  const maxModelLen = getDeploymentMaxModelLen(gpuType);
  setSetting("vllm_max_model_len", String(maxModelLen));

  const cmd: string[] = [
    "--model", model,
    "--host", "0.0.0.0",
    "--port", String(VLLM_PORT),
    "--trust-remote-code",
  ];

  if (cpuBackend) {
    // On CPU this caps vLLM's memory pool — must be high enough to load model weights.
    cmd.push("--gpu-memory-utilization", "0.85");
    cmd.push("--dtype", process.arch === "arm64" ? "bfloat16" : "float32");
    cmd.push("--max-model-len", String(maxModelLen));
  } else {
    cmd.push("--max-model-len", String(maxModelLen));
    cmd.push("--gpu-memory-utilization", String(gpuUtil));
    cmd.push("--dtype", "auto");
  }

  const hfToken = process.env.HF_TOKEN || "";

  const hostConfig: Dockerode.HostConfig = {
    IpcMode: "private",
    PortBindings: { [`${VLLM_PORT}/tcp`]: [{ HostPort: String(VLLM_PORT) }] },
    Binds: [
      `${process.env.HF_CACHE || "/tmp/hf_cache"}:/root/.cache/huggingface`,
    ],
    ShmSize: cpuBackend ? 4 * 1024 * 1024 * 1024 : 2 * 1024 * 1024 * 1024,
  };

  if (cpuBackend) {
    hostConfig.SecurityOpt = ["seccomp=unconfined"];
    hostConfig.CapAdd = ["SYS_NICE"];
  } else {
    hostConfig.DeviceRequests = [{
      Driver: "nvidia",
      Count: -1,
      Capabilities: [["gpu"]],
    }];
  }

  const env = [
    `HF_XET_HIGH_PERFORMANCE=1`,
    `HF_TOKEN=${hfToken}`,
    `HUGGING_FACE_HUB_TOKEN=${hfToken}`,
    `VLLM_WORKER_MULTIPROC_METHOD=spawn`,
  ];
  if (cpuBackend) {
    env.push("CUDA_VISIBLE_DEVICES=");
    env.push("VLLM_TARGET_DEVICE=cpu");
    env.push("VLLM_CPU_KVCACHE_SPACE=1");
    env.push("VLLM_CPU_OMP_THREADS_BIND=auto");
  }

  const container = await docker.createContainer({
    name: VLLM_CONTAINER_NAME,
    Image: image,
    Cmd: cmd,
    ExposedPorts: { [`${VLLM_PORT}/tcp`]: {} },
    HostConfig: hostConfig,
    NetworkingConfig: {
      EndpointsConfig: {
        [VLLM_NETWORK]: {},
      },
    },
    Env: env,
  });

  await container.start();
  return container;
}

function clearDeployProgress() {
  setSetting("vllm_progress", "");
  setSetting("vllm_progress_pct", "");
  setSetting("vllm_activity", "");
  setSetting("vllm_recent_log", "");
  setSetting("vllm_deploy_started_at", "");
}

function markDeployStarted() {
  if (!getSetting("vllm_deploy_started_at")) {
    setSetting("vllm_deploy_started_at", new Date().toISOString());
  }
}

function updateDeployProgress(opts: { progress?: string; pct?: number; activity?: string; recentLog?: string }) {
  if (opts.progress != null) setSetting("vllm_progress", opts.progress);
  if (opts.pct != null) setSetting("vllm_progress_pct", String(Math.max(0, Math.min(100, Math.round(opts.pct)))));
  if (opts.activity != null) setSetting("vllm_activity", opts.activity);
  if (opts.recentLog != null) setSetting("vllm_recent_log", opts.recentLog.slice(0, 500));
}

function stripDockerLogLine(chunk: Buffer): string {
  const text = chunk.length > 8 ? chunk.slice(8).toString("utf8") : chunk.toString("utf8");
  return text.replace(/[\x00-\x08\x0b-\x1f]/g, "").trim();
}

function parseVllmLogLine(line: string): { activity: string; pct?: number; progress?: string } | null {
  if (!line) return null;

  const pctBar = line.match(/(\d{1,3})%\|[█▏▎▍▌▋▊▉\s]/);
  if (pctBar) {
    const pct = Number(pctBar[1]);
    return {
      activity: "Downloading model from Hugging Face…",
      pct: Math.max(10, Math.min(90, pct)),
      progress: `Downloading model weights… ${pct}%`,
    };
  }

  const shard = line.match(/(\d+)\/(\d+)\s*(files?|shards?)/i);
  if (shard) {
    const done = Number(shard[1]);
    const total = Number(shard[2]);
    const pct = total > 0 ? Math.round((done / total) * 100) : undefined;
    return {
      activity: "Downloading model from Hugging Face…",
      pct: pct != null ? Math.max(10, Math.min(85, pct)) : 20,
      progress: `Downloading model files… ${done}/${total}`,
    };
  }

  if (/Loading safetensors checkpoint shards/i.test(line)) {
    const pct = line.match(/(\d+)% Completed/);
    return {
      activity: "Loading model weights…",
      pct: pct ? Math.max(40, Math.min(85, Number(pct[1]))) : 50,
      progress: pct ? `Loading model weights… ${pct[1]}%` : "Loading model weights…",
    };
  }
  if (/download|fetching|huggingface|hf_hub/i.test(line)) {
    return { activity: "Downloading model from Hugging Face…", pct: 20, progress: "Downloading model weights…" };
  }
  if (/Starting to load model|load model/i.test(line)) {
    return { activity: "Loading model into memory…", pct: 55, progress: "Loading model weights into memory…" };
  }
  if (/Resolved architecture|Using max model len/i.test(line)) {
    return { activity: "Preparing model…", pct: 30, progress: "Preparing model configuration…" };
  }
  if (/Initializing a V1 LLM engine|EngineCore|cpu_model_runner/i.test(line)) {
    return { activity: "Starting inference engine…", pct: 45, progress: "Starting vLLM inference engine…" };
  }
  if (/compilation|inductor|torch\.compile/i.test(line)) {
    return { activity: "Compiling model kernels…", pct: 70, progress: "Compiling model (first run can take several minutes)…" };
  }
  if (/Application startup complete|Starting vLLM server|Available routes/i.test(line)) {
    return { activity: "Almost ready…", pct: 92, progress: "Starting API server…" };
  }
  return null;
}

function elapsedDeployPct(status: string, startedAt: string | null): number | null {
  if (!startedAt) return null;
  const elapsedMs = Date.now() - new Date(startedAt).getTime();
  if (status === "pulling") return Math.min(12, 4 + elapsedMs / 45_000);
  if (status === "starting") return Math.min(88, 12 + (1 - Math.exp(-elapsedMs / 240_000)) * 76);
  return null;
}

function watchVllmStartupLogs(container: Dockerode.Container, isCancelled?: () => boolean): { stop(): void } {
  let stopped = false;
  let streamRef: NodeJS.ReadableStream | null = null;

  container.logs({ stdout: true, stderr: true, follow: true, tail: 0 }, (err, stream) => {
    if (err || !stream || stopped) return;
    streamRef = stream;

    stream.on("data", (chunk: Buffer) => {
      if (stopped || isCancelled?.()) return;
      for (const raw of stripDockerLogLine(chunk).split("\n")) {
        const parsed = parseVllmLogLine(raw);
        if (!parsed) continue;
        updateDeployProgress({
          progress: parsed.progress,
          pct: parsed.pct,
          activity: parsed.activity,
          recentLog: raw.slice(0, 200),
        });
      }
    });
  });

  return {
    stop() {
      stopped = true;
      try { (streamRef as unknown as { destroy(): void })?.destroy(); } catch { /* ok */ }
      streamRef = null;
    },
  };
}

/** If deploy is stuck on starting but the container died, surface the error immediately. */
export async function syncDeployStateFromContainer(): Promise<void> {
  const status = getSetting("vllm_status");
  if (status !== "starting" && status !== "pulling") return;

  const info = await getVllmContainerInfo();
  if (!info) {
    if (status === "starting") {
      setSetting("vllm_status", "error");
      setSetting("vllm_error", "vLLM container disappeared during deployment.");
      clearDeployProgress();
    }
    return;
  }
  if (info.State.Running) return;

  const crash = await getContainerCrashReason(docker.getContainer(VLLM_CONTAINER_NAME));
  if (crash) {
    setSetting("vllm_status", "error");
    setSetting("vllm_error", `vLLM failed to start. ${crash}`);
    clearDeployProgress();
  }
}

async function waitForVllmWithProgress(
  container: Dockerode.Container,
  timeoutMs = 600_000,
  isCancelled?: () => boolean,
): Promise<boolean> {
  markDeployStarted();
  const watcher = watchVllmStartupLogs(container, isCancelled);
  const tick = setInterval(() => {
    if (isCancelled?.()) return;
    const status = getSetting("vllm_status") || "starting";
    const startedAt = getSetting("vllm_deploy_started_at");
    const elapsed = elapsedDeployPct(status, startedAt);
    const current = Number(getSetting("vllm_progress_pct") || 0);
    if (elapsed != null && elapsed > current) {
      setSetting("vllm_progress_pct", String(Math.round(elapsed)));
    }
  }, 5000);

  try {
    return await waitForVllm(timeoutMs, isCancelled, container);
  } finally {
    clearInterval(tick);
    watcher.stop();
  }
}

// Poll vLLM health endpoint until ready or timeout
async function waitForVllm(
  timeoutMs = 600_000,
  isCancelled?: () => boolean,
  container?: Dockerode.Container,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = VLLM_URL + "/health";

  while (Date.now() < deadline) {
    if (isCancelled?.()) return false;

    if (container) {
      const crash = await getContainerCrashReason(container);
      if (crash) {
        throw new Error(`vLLM failed to start. ${crash}`);
      }
    }

    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}

// Watch container logs for OOM error within a time window
async function watchForOom(container: Dockerode.Container, windowMs = 180_000): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timeout = setTimeout(() => resolve(false), windowMs);

    container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail: 0,  // only new lines
    }, (err, stream) => {
      if (err || !stream) {
        clearTimeout(timeout);
        resolve(false);
        return;
      }

      let accumulated = "";
      stream.on("data", (chunk: Buffer) => {
        // Docker log frames have an 8-byte header we strip
        const text = chunk.length > 8
          ? chunk.slice(8).toString("utf8")
          : chunk.toString("utf8");
        accumulated += text;

        if (/cuda out of memory|OutOfMemoryError|failed to allocate|CUDA error: out of memory/i.test(accumulated)) {
          clearTimeout(timeout);
          try { (stream as unknown as { destroy(): void }).destroy(); } catch { /* ok */ }
          resolve(true);
        }
      });

      stream.on("error", () => { clearTimeout(timeout); resolve(false); });
      stream.on("end",   () => { clearTimeout(timeout); resolve(false); });
    });
  });
}

async function getContainerCrashReason(container: Dockerode.Container): Promise<string | null> {
  try {
    const info = await container.inspect();
    if (info.State.Running) return null;

    const dockerMemGb = await getDockerMemoryGb();
    const memLabel = dockerMemGb != null ? `${dockerMemGb.toFixed(1)}GB` : "unknown";

    if (info.State.OOMKilled) {
      return `Container killed by Docker (out of memory). Docker has ${memLabel} allocated (~${DOCKER_STUDIO_OVERHEAD_GB}GB used by Inference Studio). Increase memory in Admin → Settings or Docker Desktop → Resources (16GB+ recommended for 3B+ models).`;
    }
    return `Container exited with code ${info.State.ExitCode}`;
  } catch {
    return "Container disappeared";
  }
}

// Watch for container crash within a window (catches startup crashes)
async function watchForCrash(container: Dockerode.Container, windowMs = 30_000): Promise<string | null> {
  await new Promise(r => setTimeout(r, windowMs));
  return getContainerCrashReason(container);
}

function formatPullProgress(event: { status?: string; progressDetail?: { current?: number; total?: number }; id?: string }): string {
  const { current, total } = event.progressDetail ?? {};
  if (current != null && total != null && total > 0) {
    const pct = Math.round((current / total) * 100);
    const mb = (n: number) => (n / 1_048_576).toFixed(0);
    updateDeployProgress({
      pct: Math.max(2, Math.min(12, pct * 0.12)),
      activity: "Pulling Docker image…",
      progress: `${event.status ?? "Downloading"} ${pct}% (${mb(current)}/${mb(total)} MB)`,
    });
    return `${event.status ?? "Downloading"} ${pct}% (${mb(current)}/${mb(total)} MB)`;
  }
  const msg = event.status ?? "Pulling Docker image…";
  updateDeployProgress({ activity: "Pulling Docker image…", progress: msg, pct: 5 });
  return msg;
}

async function checkVllmHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${VLLM_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** If vLLM is healthy but DB still says "starting", promote to "running" (e.g. after API restart mid-deploy). */
export async function syncVllmStatusIfReady(): Promise<void> {
  const status = getSetting("vllm_status");
  if (status !== "starting" || !getSetting("vllm_model")) return;
  if (!(await checkVllmHealth())) return;
  setSetting("vllm_status", "running");
  setSetting("vllm_error", "");
  clearDeployProgress();
}

async function getVllmContainerInfo(): Promise<Dockerode.ContainerInspectInfo | null> {
  try {
    return await docker.getContainer(VLLM_CONTAINER_NAME).inspect();
  } catch {
    return null;
  }
}

let recoveryPromise: Promise<void> | null = null;

/** After API restart, resume or redeploy the last model instead of surfacing "unreachable". */
export async function recoverDeploymentIfNeeded(): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  if (isDeploymentInProgress()) return;

  const storedStatus = getSetting("vllm_status");
  const model = getSetting("vllm_model");
  if (!model || storedStatus !== "running") return;

  recoveryPromise = (async () => {
    try {
      if (await checkVllmHealth()) {
        setSetting("vllm_status", "running");
        setSetting("vllm_error", "");
        setSetting("vllm_progress", "");
        return;
      }

      const info = await getVllmContainerInfo();

      if (info?.State?.Running) {
        setSetting("vllm_status", "starting");
        setSetting("vllm_error", "");
        setSetting("vllm_progress", "Waiting for vLLM to become ready…");

        const healthy = await waitForVllm(480_000);
        if (healthy) {
          setSetting("vllm_status", "running");
          setSetting("vllm_error", "");
          setSetting("vllm_progress", "");
          return;
        }

        const crashReason = await watchForCrash(
          docker.getContainer(VLLM_CONTAINER_NAME),
          0,
        );
        if (crashReason) {
          console.warn("[recovery] vLLM container crashed:", crashReason);
        }
      }

      setSetting("vllm_status", "starting");
      setSetting("vllm_error", "");
      setSetting("vllm_progress", "Restarting vLLM after service restart…");
      await deployModel(model);
    } catch (e) {
      if (!(e instanceof DeployCancelledError)) {
        console.error("[recovery] failed:", e);
      }
    } finally {
      recoveryPromise = null;
    }
  })();

  return recoveryPromise;
}

async function containerExists(): Promise<boolean> {
  try {
    await docker.getContainer(VLLM_CONTAINER_NAME).inspect();
    return true;
  } catch {
    return false;
  }
}

async function pullDockerImage(image: string, myGen: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      activePullStream = stream;
      docker.modem.followProgress(
        stream,
        (err2: Error | null) => {
          activePullStream = null;
          if (isDeployCancelled(myGen)) return reject(new DeployCancelledError());
          err2 ? reject(err2) : resolve();
        },
        (event: { status?: string; progressDetail?: { current?: number; total?: number }; id?: string }) => {
          if (isDeployCancelled(myGen)) {
            try { (stream as unknown as { destroy(): void }).destroy(); } catch { /* ok */ }
            return;
          }
          setSetting("vllm_progress", formatPullProgress(event));
        },
      );
    });
  });
}

async function finishCpuDeploy(container: Dockerode.Container, myGen: number): Promise<void> {
  const healthy = await waitForVllmWithProgress(container, 480_000, () => isDeployCancelled(myGen));
  if (isDeployCancelled(myGen)) throw new DeployCancelledError();
  if (healthy) {
    setSetting("vllm_status", "running");
    setSetting("vllm_error", "");
    clearDeployProgress();
    return;
  }

  const crashReason = await getContainerCrashReason(container);
  if (crashReason) {
    const logs = await container.logs({ stdout: true, stderr: true, tail: 30 }).catch(() => null);
    const logText = logs
      ? Buffer.isBuffer(logs) ? logs.slice(8).toString() : String(logs)
      : "";
    throw new Error(`vLLM failed to start. ${crashReason}.\n${logText}`);
  }

  throw new Error("vLLM health check timed out after 8 minutes.");
}

// Main deployment function
export async function deployModel(model: string): Promise<void> {
  const myGen = ++deployGeneration;
  const gpuType = GPU_TYPE_ENV;
  const image = getVllmImage(gpuType);

  setSetting("vllm_status", "pulling");
  setSetting("vllm_model", model);
  setSetting("vllm_error", "");
  clearDeployProgress();
  markDeployStarted();
  setSetting("vllm_progress", `Pulling ${image}…`);
  setSetting("vllm_activity", "Pulling Docker image…");
  setSetting("vllm_progress_pct", "3");

  try {
    await pullDockerImage(image, myGen);

    if (isDeployCancelled(myGen)) throw new DeployCancelledError();

    setSetting("vllm_status", "starting");
    updateDeployProgress({
      progress: usesCpuBackend(gpuType)
        ? "Starting vLLM on CPU (Docker cannot use Apple Metal)…"
        : "Starting vLLM container…",
      activity: "Starting vLLM engine…",
      pct: 15,
    });

    if (usesCpuBackend(gpuType)) {
      setSetting("vllm_gpu_util", "");
      const container = await runVllmContainer(model, 0, gpuType);
      if (isDeployCancelled(myGen)) throw new DeployCancelledError();
      await finishCpuDeploy(container, myGen);
      return;
    }

    let gpuUtil    = 0.90;
    let lastError  = "";

    // OOM-retry loop
    while (gpuUtil >= 0.45) {
      if (isDeployCancelled(myGen)) throw new DeployCancelledError();

      setSetting("vllm_gpu_util", String(gpuUtil));
      if (lastError) {
        setSetting("vllm_progress", `OOM — retrying at gpu_memory_utilization=${gpuUtil.toFixed(2)}`);
      } else {
        setSetting("vllm_progress", "Starting vLLM container…");
      }

      let container: Dockerode.Container;
      try {
        container = await runVllmContainer(model, gpuUtil, gpuType);
      } catch (e) {
        throw new Error(`Failed to start container: ${e instanceof Error ? e.message : e}`);
      }

      if (isDeployCancelled(myGen)) throw new DeployCancelledError();

      // Race: wait for OOM (fast fail) vs healthy startup
      const oomPromise = watchForOom(container, 120_000);

      // Also poll health — whichever resolves first wins
      let ready = false;
      const healthPromise = (async () => {
        const ok = await waitForVllmWithProgress(container, 480_000, () => isDeployCancelled(myGen));
        ready = ok;
        return ok;
      })();

      const oom = await Promise.race([oomPromise, healthPromise.then(() => false)]);

      if (oom) {
        lastError = "OOM detected";
        gpuUtil   = Math.round((gpuUtil - 0.10) * 100) / 100;
        await stopVllm();
        if (isDeployCancelled(myGen)) throw new DeployCancelledError();
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // No OOM — wait for health to resolve
      const healthy = await healthPromise;
      if (isDeployCancelled(myGen)) throw new DeployCancelledError();
      if (healthy) {
        setSetting("vllm_status", "running");
        setSetting("vllm_error", "");
        clearDeployProgress();
        return;
      }

      // Check if container crashed for a reason other than OOM
      if (isDeployCancelled(myGen)) throw new DeployCancelledError();
      const crashReason = await watchForCrash(container, 0);
      if (crashReason) {
        // Get tail of logs for the error message
        const logs = await container.logs({ stdout: true, stderr: true, tail: 20 }).catch(() => null);
        const logText = logs
          ? Buffer.isBuffer(logs)
            ? logs.slice(8).toString()
            : String(logs)
          : "";
        throw new Error(`vLLM failed to start. ${crashReason}.\n${logText}`);
      }

      throw new Error("vLLM health check timed out after 8 minutes.");
    }

    throw new Error(`Cannot fit model in GPU memory even at gpu_memory_utilization=0.45. Try a smaller model (Phi-4 Mini or TinyLlama).`);
  } catch (e) {
    if (e instanceof DeployCancelledError || isDeployCancelled(myGen)) return;
    setSetting("vllm_status", "error");
    setSetting("vllm_error", e instanceof Error ? e.message : String(e));
    setSetting("vllm_progress", "");
    throw e;
  }
}

// Async generator: stream vLLM container logs (or pull progress before container exists)
export async function* vllmLogs(tail = 100): AsyncGenerator<string> {
  while (getSetting("vllm_status") === "pulling") {
    const progress = getSetting("vllm_progress");
    yield `[pull] ${progress || "Pulling Docker image…"}\n`;
    await new Promise(r => setTimeout(r, 2000));
  }

  while (!(await containerExists())) {
    const status = getSetting("vllm_status");
    if (status === "idle" || status === "error") return;
    const progress = getSetting("vllm_progress");
    yield `[info] ${progress || "Waiting for container to start…"}\n`;
    await new Promise(r => setTimeout(r, 2000));
  }

  try {
    const container = docker.getContainer(VLLM_CONTAINER_NAME);
    const stream = await container.logs({
      stdout: true, stderr: true, follow: true, tail, timestamps: true,
    }) as NodeJS.ReadableStream;

    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      const line = buf.length > 8 ? buf.slice(8).toString("utf8") : buf.toString("utf8");
      yield line;
    }
  } catch (e) {
    yield `[error] ${e instanceof Error ? e.message : e}\n`;
  }
}
