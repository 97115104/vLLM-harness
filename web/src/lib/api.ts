const BASE = "";  // rewrites handle routing to API

export async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
  return res;
}

export async function adminFetch(path: string, token: string, opts?: RequestInit) {
  return apiFetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts?.headers ?? {}) },
  });
}

export async function getSetupStatus() {
  const r = await apiFetch("/api/setup/status");
  return r.json() as Promise<{
    status: "idle" | "pulling" | "starting" | "running" | "error";
    model: string | null;
    error: string | null;
    gpu_util: string | null;
    tunnel_url: string | null;
  }>;
}

export async function getModels() {
  const r = await apiFetch("/api/setup/models");
  const d = await r.json() as { models: Model[] };
  return d.models;
}

export interface Model {
  id: string; name: string; description: string;
  params: string; vram_gb: number; vram_int8_gb: number; context_k: number;
  tags: string[]; no_auth: boolean;
}
