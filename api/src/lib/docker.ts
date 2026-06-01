import Dockerode from "dockerode";
import db from "../db/index.js";

export const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export const VLLM_CONTAINER_NAME = "inference-studio-vllm";
export const VLLM_NETWORK        = process.env.DOCKER_NETWORK || "inference-studio_default";
export const VLLM_PORT           = 8000;

function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')"
  ).run(key, value);
}

function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
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

export async function stopVllm() {
  try {
    const c = docker.getContainer(VLLM_CONTAINER_NAME);
    const info = await c.inspect().catch(() => null);
    if (info?.State.Running) await c.stop({ t: 10 });
    await c.remove({ force: true }).catch(() => null);
  } catch { /* already stopped */ }
  setSetting("vllm_status", "idle");
  setSetting("vllm_model", "");
  setSetting("vllm_error", "");
}

async function detectGpu(): Promise<{ type: "nvidia" | "cpu"; vram_gb: number | null }> {
  try {
    const exec = await docker.run(
      "nvidia/cuda:12.1.0-base-ubuntu22.04",
      ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      process.stdout as NodeJS.WriteStream,
      { HostConfig: { DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }] } }
    );
    if (Array.isArray(exec) && exec[0]?.StatusCode === 0) {
      const output = String(exec[1]).trim();
      const mb = parseInt(output.split("\n")[0]);
      return { type: "nvidia", vram_gb: Math.round(mb / 1024) };
    }
  } catch { /* no nvidia */ }
  return { type: "cpu", vram_gb: null };
}

async function runVllmContainer(model: string, gpuUtil: number, gpuType: "nvidia" | "cpu") {
  await stopVllm().catch(() => null);

  const cmd = [
    "--model", model,
    "--host", "0.0.0.0",
    "--port", String(VLLM_PORT),
    "--max-model-len", "4096",
    "--trust-remote-code",
  ];

  if (gpuType === "nvidia") {
    cmd.push("--gpu-memory-utilization", String(gpuUtil));
  } else {
    cmd.push("--device", "cpu");
  }

  const hostConfig: Dockerode.HostConfig = {
    PortBindings: { [`${VLLM_PORT}/tcp`]: [{ HostPort: String(VLLM_PORT) }] },
    IpcMode: "host",
    NetworkMode: VLLM_NETWORK,
    Binds: [`${process.env.HF_CACHE || "/tmp/hf_cache"}:/root/.cache/huggingface`],
  };

  if (gpuType === "nvidia") {
    hostConfig.DeviceRequests = [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }];
  }

  const container = await docker.createContainer({
    name: VLLM_CONTAINER_NAME,
    Image: "vllm/vllm-openai:latest",
    Cmd: cmd,
    ExposedPorts: { [`${VLLM_PORT}/tcp`]: {} },
    HostConfig: hostConfig,
    Env: ["HF_HUB_ENABLE_HF_TRANSFER=1"],
  });
  await container.start();
  return container;
}

async function waitForVllm(timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://localhost:${VLLM_PORT}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

async function watchForOom(container: Dockerode.Container): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), 120_000);
    container.logs({ stdout: true, stderr: true, follow: true, tail: 50 }, (err, stream) => {
      if (err || !stream) { clearTimeout(timeout); resolve(false); return; }
      stream.on("data", (chunk: Buffer) => {
        const line = chunk.toString();
        if (/cuda out of memory|OutOfMemoryError|failed to allocate/i.test(line)) {
          clearTimeout(timeout);
          stream.destroy();
          resolve(true);
        }
      });
      stream.on("end", () => { clearTimeout(timeout); resolve(false); });
    });
  });
}

// Deploy a model — retries with decreasing GPU utilization on OOM
export async function deployModel(model: string): Promise<void> {
  setSetting("vllm_status", "pulling");
  setSetting("vllm_model", model);
  setSetting("vllm_error", "");

  try {
    // Pull image
    await new Promise<void>((resolve, reject) => {
      docker.pull("vllm/vllm-openai:latest", (err: Error, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => err2 ? reject(err2) : resolve());
      });
    });

    const gpu = await detectGpu();
    setSetting("vllm_status", "starting");

    let gpuUtil = 0.90;
    let oom = true;

    while (oom && gpuUtil >= 0.50) {
      setSetting("vllm_gpu_util", String(gpuUtil));
      const container = await runVllmContainer(model, gpuUtil, gpu.type);

      // Give it a few seconds to fail fast on OOM
      await new Promise(r => setTimeout(r, 8000));
      oom = await watchForOom(container);

      if (oom) {
        gpuUtil = Math.round((gpuUtil - 0.10) * 100) / 100;
        setSetting("vllm_error", `OOM — retrying at gpu_memory_utilization=${gpuUtil}`);
        await stopVllm();
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (oom) throw new Error("Cannot fit model in GPU memory even at 50% utilization. Try a smaller model.");

    const ready = await waitForVllm();
    if (!ready) throw new Error("vLLM failed to start within 5 minutes.");

    setSetting("vllm_status", "running");
    setSetting("vllm_error", "");
  } catch (e) {
    setSetting("vllm_status", "error");
    setSetting("vllm_error", String(e instanceof Error ? e.message : e));
    throw e;
  }
}

// Stream vLLM container logs as an async generator
export async function* vllmLogs(tail = 100): AsyncGenerator<string> {
  try {
    const container = docker.getContainer(VLLM_CONTAINER_NAME);
    const stream = await container.logs({ stdout: true, stderr: true, follow: true, tail, timestamps: true }) as NodeJS.ReadableStream;
    for await (const chunk of stream) {
      yield (chunk as Buffer).toString().replace(/[\x00-\x08]/g, "");
    }
  } catch (e) {
    yield `[error] ${e instanceof Error ? e.message : e}\n`;
  }
}
