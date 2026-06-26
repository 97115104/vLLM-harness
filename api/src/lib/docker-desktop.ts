import { request as httpRequest } from "node:http";
import { clearDockerMemoryCache } from "./docker.js";

const SOCKET_PATH = process.env.DOCKER_DESKTOP_SOCKET || "";
const PROXY_URL = process.env.DOCKER_DESKTOP_PROXY || "";

type DesktopResponse = { status: number; body: string };

async function desktopRequest(path: string, opts?: { method?: string; body?: unknown }): Promise<DesktopResponse> {
  if (!SOCKET_PATH && !PROXY_URL) {
    throw new Error("Docker Desktop API not configured");
  }

  const method = opts?.method ?? "GET";
  const payload = opts?.body != null ? JSON.stringify(opts.body) : undefined;

  if (PROXY_URL) {
    const url = new URL(path, PROXY_URL.endsWith("/") ? PROXY_URL : `${PROXY_URL}/`);
    const res = await fetch(url, {
      method,
      headers: payload ? { "Content-Type": "application/json" } : {},
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.text() };
  }

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      res => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function isDockerDesktopAvailable(): boolean {
  return Boolean(SOCKET_PATH || PROXY_URL);
}

export type DockerDesktopResources = {
  available: boolean;
  memory_mib: number | null;
  memory_min_mib: number | null;
  memory_max_mib: number | null;
  swap_mib: number | null;
  cpus: number | null;
  host_os: string | null;
};

export async function getDockerDesktopResources(): Promise<DockerDesktopResources> {
  if (!isDockerDesktopAvailable()) {
    return { available: false, memory_mib: null, memory_min_mib: null, memory_max_mib: null, swap_mib: null, cpus: null, host_os: null };
  }

  try {
    const [settingsRes, infoRes] = await Promise.all([
      desktopRequest("/app/settings"),
      desktopRequest("/system/info"),
    ]);

    if (settingsRes.status !== 200) {
      return { available: false, memory_mib: null, memory_min_mib: null, memory_max_mib: null, swap_mib: null, cpus: null, host_os: null };
    }

    const settings = JSON.parse(settingsRes.body) as {
      vm?: { resources?: { memoryMiB?: { value?: number; min?: number; max?: number }; swapMiB?: { value?: number }; cpus?: { value?: number } } };
    };
    const info = infoRes.status === 200
      ? JSON.parse(infoRes.body) as { goos?: string }
      : { goos: null };

    const mem = settings.vm?.resources?.memoryMiB;
    return {
      available: true,
      memory_mib: mem?.value ?? null,
      memory_min_mib: mem?.min ?? null,
      memory_max_mib: mem?.max ?? null,
      swap_mib: settings.vm?.resources?.swapMiB?.value ?? null,
      cpus: settings.vm?.resources?.cpus?.value ?? null,
      host_os: info.goos ?? null,
    };
  } catch {
    return { available: false, memory_mib: null, memory_min_mib: null, memory_max_mib: null, swap_mib: null, cpus: null, host_os: null };
  }
}

export async function setDockerDesktopMemory(memoryMiB: number, restart = true): Promise<{ restart_required: boolean; will_restart: boolean }> {
  const res = await desktopRequest("/app/settings", {
    method: "POST",
    body: { memoryMiB },
  });

  if (res.status !== 200) {
    let message = `Docker Desktop rejected memory change (HTTP ${res.status})`;
    try {
      const err = JSON.parse(res.body) as { message?: string };
      if (err.message) message = err.message;
    } catch { /* use default */ }
    throw new Error(message);
  }

  let restartRequired = restart;
  try {
    const check = await desktopRequest("/app/settings/do_changes_need_restart");
    if (check.status === 200) {
      restartRequired = JSON.parse(check.body) === true;
    }
  } catch { /* fall through */ }

  const willRestart = restart && restartRequired;
  if (willRestart) {
    const restartRes = await desktopRequest("/engine/restart", { method: "POST" });
    if (restartRes.status !== 200 && restartRes.status !== 204) {
      throw new Error("Memory updated but Docker engine restart failed — restart Docker Desktop manually.");
    }
  }

  return { restart_required: restartRequired, will_restart: willRestart };
}

/** Apply memory in background — must not run on the HTTP request thread (Docker restart kills containers). */
export function applyDockerDesktopMemoryInBackground(memoryMiB: number, restart: boolean): void {
  setTimeout(() => {
    void setDockerDesktopMemory(memoryMiB, restart).then(() => {
      clearDockerMemoryCache();
    }).catch(err => {
      console.error("[docker-desktop] background memory apply failed:", err);
    });
  }, 300);
}
