import Dockerode from "dockerode";
import db from "../db/index.js";

export const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export const VLLM_CONTAINER_NAME = "inference-studio-vllm";
export const VLLM_PORT           = Number(process.env.VLLM_PORT ?? 8000);
export const VLLM_NETWORK        = process.env.DOCKER_NETWORK || "inference-studio_default";
const VLLM_URL                   = process.env.VLLM_URL || `http://inference-studio-vllm:${VLLM_PORT}`;

// GPU_TYPE is passed from deploy-locally.sh via docker-compose environment
// Values: "nvidia" | "metal" | "cpu"
const GPU_TYPE_ENV = (process.env.GPU_TYPE || "cpu") as "nvidia" | "metal" | "cpu";

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

export function getVllmStatus() {
  return {
    status:   getSetting("vllm_status") || "idle",
    model:    getSetting("vllm_model"),
    error:    getSetting("vllm_error"),
    gpu_util: getSetting("vllm_gpu_util"),
  };
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

  // Build vLLM command
  const cmd: string[] = [
    "--model", model,
    "--host", "0.0.0.0",
    "--port", String(VLLM_PORT),
    "--trust-remote-code",
    "--max-model-len", "4096",
  ];

  if (gpuType === "nvidia") {
    cmd.push("--gpu-memory-utilization", String(gpuUtil));
    cmd.push("--dtype", "auto");
  } else {
    // CPU / Metal fallback
    cmd.push("--device", "cpu");
    cmd.push("--dtype", "float32");
    cmd.push("--max-model-len", "2048");  // reduce for CPU
  }

  // HuggingFace token (if set by deploy flow)
  const hfToken = process.env.HF_TOKEN || "";

  const hostConfig: Dockerode.HostConfig = {
    IpcMode: "private",
    // Expose port on host for debugging convenience
    PortBindings: { [`${VLLM_PORT}/tcp`]: [{ HostPort: String(VLLM_PORT) }] },
    Binds: [
      `${process.env.HF_CACHE || "/tmp/hf_cache"}:/root/.cache/huggingface`,
    ],
    // 2 GB shared memory for attention/KV cache
    ShmSize: 2 * 1024 * 1024 * 1024,
  };

  if (gpuType === "nvidia") {
    hostConfig.DeviceRequests = [{
      Driver: "nvidia",
      Count: -1,
      Capabilities: [["gpu"]],
    }];
  }

  const container = await docker.createContainer({
    name: VLLM_CONTAINER_NAME,
    Image: "vllm/vllm-openai:latest",
    Cmd: cmd,
    ExposedPorts: { [`${VLLM_PORT}/tcp`]: {} },
    HostConfig: hostConfig,
    // Attach to the compose network so API can resolve by container name
    NetworkingConfig: {
      EndpointsConfig: {
        [VLLM_NETWORK]: {},
      },
    },
    Env: [
      `HF_HUB_ENABLE_HF_TRANSFER=1`,
      `HF_TOKEN=${hfToken}`,
      `HUGGING_FACE_HUB_TOKEN=${hfToken}`,
      `VLLM_WORKER_MULTIPROC_METHOD=spawn`,
    ],
  });

  await container.start();
  return container;
}

// Poll vLLM health endpoint until ready or timeout
async function waitForVllm(timeoutMs = 600_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // VLLM_URL is http://host.docker.internal:8000 from inside the API container
  // host.docker.internal resolves to the Docker gateway, which reaches the host's
  // vLLM container (running with --network host) at that port.
  const healthUrl = VLLM_URL + "/health";

  while (Date.now() < deadline) {
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
          try { (stream as NodeJS.ReadableStream).destroy(); } catch { /* ok */ }
          resolve(true);
        }
      });

      stream.on("error", () => { clearTimeout(timeout); resolve(false); });
      stream.on("end",   () => { clearTimeout(timeout); resolve(false); });
    });
  });
}

// Watch for container crash within a window (catches startup crashes)
async function watchForCrash(container: Dockerode.Container, windowMs = 30_000): Promise<string | null> {
  await new Promise(r => setTimeout(r, windowMs));
  try {
    const info = await container.inspect();
    if (info.State.Running) return null;
    // Container died — return exit code info
    return `Container exited with code ${info.State.ExitCode}`;
  } catch {
    return "Container disappeared";
  }
}

// Main deployment function — retries with lower GPU utilization on OOM
export async function deployModel(model: string): Promise<void> {
  setSetting("vllm_status", "pulling");
  setSetting("vllm_model", model);
  setSetting("vllm_error", "");

  try {
    // Pull the vLLM Docker image
    setSetting("vllm_error", "Pulling Docker image…");
    await new Promise<void>((resolve, reject) => {
      docker.pull("vllm/vllm-openai:latest", (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => {
          err2 ? reject(err2) : resolve();
        });
      });
    });

    setSetting("vllm_status", "starting");
    setSetting("vllm_error", "");

    const gpuType = GPU_TYPE_ENV;
    let gpuUtil    = 0.90;
    let lastError  = "";

    // OOM-retry loop
    while (gpuUtil >= 0.45) {
      setSetting("vllm_gpu_util", String(gpuUtil));
      if (lastError) {
        setSetting("vllm_error", `OOM — retrying at gpu_memory_utilization=${gpuUtil.toFixed(2)}`);
      }

      let container: Dockerode.Container;
      try {
        container = await runVllmContainer(model, gpuUtil, gpuType);
      } catch (e) {
        throw new Error(`Failed to start container: ${e instanceof Error ? e.message : e}`);
      }

      // Race: wait for OOM (fast fail) vs healthy startup
      const oomPromise = watchForOom(container, 120_000);

      // Also poll health — whichever resolves first wins
      let ready = false;
      const healthPromise = (async () => {
        const ok = await waitForVllm(480_000);
        ready = ok;
        return ok;
      })();

      const oom = await Promise.race([oomPromise, healthPromise.then(() => false)]);

      if (oom) {
        lastError = "OOM detected";
        gpuUtil   = Math.round((gpuUtil - 0.10) * 100) / 100;
        await stopVllm();
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // No OOM — wait for health to resolve
      const healthy = await healthPromise;
      if (healthy) {
        setSetting("vllm_status", "running");
        setSetting("vllm_error", "");
        return;
      }

      // Check if container crashed for a reason other than OOM
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
    setSetting("vllm_status", "error");
    setSetting("vllm_error", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// Async generator: stream vLLM container logs
export async function* vllmLogs(tail = 100): AsyncGenerator<string> {
  try {
    const container = docker.getContainer(VLLM_CONTAINER_NAME);
    const stream = await container.logs({
      stdout: true, stderr: true, follow: true, tail, timestamps: true,
    }) as NodeJS.ReadableStream;

    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      // Strip Docker frame header (8 bytes)
      const line = buf.length > 8 ? buf.slice(8).toString("utf8") : buf.toString("utf8");
      yield line;
    }
  } catch (e) {
    yield `[error] ${e instanceof Error ? e.message : e}\n`;
  }
}
