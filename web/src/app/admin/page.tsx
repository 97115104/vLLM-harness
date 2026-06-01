"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";

type Tab = "models" | "keys" | "requests" | "settings";

interface ApiKey {
  id: string; prefix: string; raw_key: string | null; name: string | null;
  owner_email: string | null; active: number; scopes: string; created_at: string; last_used_at: string | null;
}
interface Request {
  id: string; model: string; status: string; tokens_in: number | null; tokens_out: number | null;
  latency_ms: number | null; prompt_preview: string | null; created_at: string;
  key_prefix: string | null; key_name: string | null;
}
interface SetupStatus {
  status: string; model: string | null; error: string | null; gpu_util: string | null; tunnel_url: string | null;
}
interface Model { id: string; name: string; params: string; vram_gb: number; tags: string[]; no_auth: boolean; }

export default function AdminPage() {
  const router = useRouter();
  const [token, setToken]       = useState<string | null>(null);
  const [tab, setTab]           = useState<Tab>("models");
  const [keys, setKeys]         = useState<ApiKey[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [setupStatus, setSetup] = useState<SetupStatus | null>(null);
  const [models, setModels]     = useState<Model[]>([]);
  const [newKeyName, setNewKeyName]   = useState("");
  const [newKeyEmail, setNewKeyEmail] = useState("");
  const [createdKey, setCreatedKey]   = useState("");
  const [error, setError]       = useState("");
  const [curPw, setCurPw]       = useState("");
  const [newPw, setNewPw]       = useState("");
  const [pwMsg, setPwMsg]       = useState("");
  const [deployingModel, setDeployingModel] = useState("");
  const [hfToken, setHfToken]   = useState("");
  const [needsHf, setNeedsHf]   = useState<string | null>(null);
  const [logs, setLogs]         = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    const t = localStorage.getItem("admin_token");
    if (!t) { router.replace("/admin/login"); return; }
    setToken(t);
  }, [router]);

  const af = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(path, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    });
    if (res.status === 401) { localStorage.removeItem("admin_token"); router.replace("/admin/login"); throw new Error("Unauthorized"); }
    return res;
  }, [token, router]);

  const loadKeys     = useCallback(async () => { if (!token) return; try { const r = await af("/api/admin/keys"); const d = await r.json() as { keys: ApiKey[] }; setKeys(d.keys); } catch (e) { setError(String(e)); } }, [token, af]);
  const loadRequests = useCallback(async () => { if (!token) return; try { const r = await af("/api/admin/requests?limit=50"); const d = await r.json() as { requests: Request[] }; setRequests(d.requests); } catch (e) { setError(String(e)); } }, [token, af]);
  const loadSetup    = useCallback(async () => { try { const r = await fetch("/api/setup/status"); setSetup(await r.json() as SetupStatus); } catch { /* ignore */ } }, []);
  const loadModels   = useCallback(async () => { try { const r = await fetch("/api/setup/models"); const d = await r.json() as { models: Model[] }; setModels(d.models); } catch { /* ignore */ } }, []);

  useEffect(() => { if (!token) return; loadKeys(); loadRequests(); loadSetup(); loadModels(); }, [token, loadKeys, loadRequests, loadSetup, loadModels]);

  // Refresh setup status while deploying
  useEffect(() => {
    if (!["pulling", "starting"].includes(setupStatus?.status ?? "")) return;
    const t = setInterval(loadSetup, 4000);
    return () => clearInterval(t);
  }, [setupStatus?.status, loadSetup]);

  // Stream logs
  useEffect(() => {
    if (!showLogs || !token) return;
    let alive = true;
    setLogs([]);
    (async () => {
      try {
        const res = await af("/api/setup/logs");
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        while (alive) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = dec.decode(value);
          const events = text.split("\n\n").filter(Boolean);
          for (const ev of events) {
            const data = ev.replace(/^data: /, "");
            try { const d = JSON.parse(data) as { line: string }; setLogs(p => [...p.slice(-200), d.line]); } catch { /* skip */ }
          }
        }
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [showLogs, token, af]);

  const createKey = async () => {
    if (!newKeyName) return;
    try {
      const r = await af("/api/admin/keys", { method: "POST", body: JSON.stringify({ name: newKeyName, owner_email: newKeyEmail, scopes: ["chat"] }) });
      const d = await r.json() as { key?: string };
      if (d.key) setCreatedKey(d.key);
      setNewKeyName(""); setNewKeyEmail("");
      loadKeys();
    } catch (e) { setError(String(e)); }
  };

  const deleteKey = async (id: string) => {
    if (!confirm("Delete this API key?")) return;
    await af(`/api/admin/keys/${id}`, { method: "DELETE" });
    loadKeys();
  };

  const toggleKey = async (id: string, active: number) => {
    await af(`/api/admin/keys/${id}`, { method: "PATCH", body: JSON.stringify({ active: !active }) });
    loadKeys();
  };

  const changePassword = async () => {
    setPwMsg("");
    try {
      const r = await af("/api/admin/password", { method: "POST", body: JSON.stringify({ current: curPw, new: newPw }) });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (d.ok) { setPwMsg("Password updated."); setCurPw(""); setNewPw(""); }
      else setPwMsg(d.error ?? "Failed");
    } catch (e) { setPwMsg(String(e)); }
  };

  const deployModel = async (modelId: string) => {
    setError(""); setDeployingModel(modelId); setNeedsHf(null);
    try {
      const r = await af("/api/setup/deploy", { method: "POST", body: JSON.stringify({ model: modelId, hf_token: hfToken || undefined }) });
      const d = await r.json() as { error?: string; needs_hf_token?: boolean };
      if (d.needs_hf_token) { setNeedsHf(modelId); setDeployingModel(""); return; }
      if (d.error) { setError(d.error); setDeployingModel(""); return; }
      loadSetup();
    } catch (e) { setError(String(e)); }
    finally { if (!needsHf) setDeployingModel(""); }
  };

  const stopModel = async () => {
    await af("/api/setup/stop", { method: "POST" });
    loadSetup();
  };

  if (!token) return null;

  const S: Record<string, string> = { running: "#00e676", error: "#ff4757", pulling: "#ccff00", starting: "#ccff00", idle: "#444" };

  return (
    <>
      <Navbar />
      <div style={{ minHeight: "calc(100vh - 48px)", padding: "24px 24px 48px" }}>
        <div style={{ maxWidth: "900px", margin: "0 auto" }}>
          <div className="flex justify-between items-center mb-8">
            <div>
              <h1 className="text-xl font-bold" style={{ color: "#ccff00" }}>Admin</h1>
              <p className="text-xs mt-0.5" style={{ color: "#555" }}>Inference Studio management</p>
            </div>
            <button onClick={() => { localStorage.removeItem("admin_token"); router.replace("/admin/login"); }}
              className="text-xs" style={{ color: "#444" }}>Sign out</button>
          </div>

          {error && <div className="mb-4 p-3 text-sm" style={{ background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", color: "#ff4757" }}>{error}<button onClick={() => setError("")} className="ml-3" style={{ color: "#ff4757" }}>×</button></div>}

          {/* Tabs */}
          <div style={{ borderBottom: "1px solid #1e1e1e" }} className="flex gap-1 mb-6">
            {(["models", "keys", "requests", "settings"] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className="px-3 pb-2 pt-1 text-sm capitalize transition-colors"
                style={{ color: tab === t ? "#ccff00" : "#555", borderBottom: tab === t ? "2px solid #ccff00" : "2px solid transparent" }}>
                {t}
              </button>
            ))}
            <button onClick={() => { loadKeys(); loadRequests(); loadSetup(); }}
              className="ml-auto pb-2 text-xs" style={{ color: "#444" }}>↻ refresh</button>
          </div>

          {/* MODELS TAB */}
          {tab === "models" && (
            <div>
              {setupStatus && (
                <div className="mb-6 p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: S[setupStatus.status] ?? "#444" }} />
                    <span className="text-sm font-bold" style={{ color: S[setupStatus.status] ?? "#888" }}>
                      {setupStatus.status}
                    </span>
                    {setupStatus.model && (
                      <span className="text-xs font-mono" style={{ color: "#666" }}>{setupStatus.model}</span>
                    )}
                    {setupStatus.status === "running" && (
                      <button onClick={stopModel}
                        className="ml-auto text-xs px-2 py-1" style={{ border: "1px solid rgba(255,71,87,0.4)", color: "#ff4757" }}>
                        Stop model
                      </button>
                    )}
                  </div>
                  {setupStatus.error && <div className="text-xs mt-1" style={{ color: "#ff4757" }}>{setupStatus.error}</div>}
                  {setupStatus.tunnel_url && (
                    <div className="text-xs mt-2" style={{ color: "#555" }}>
                      Tunnel: <code style={{ color: "#888" }}>{setupStatus.tunnel_url}</code>
                    </div>
                  )}
                  {["pulling", "starting"].includes(setupStatus.status) && (
                    <button onClick={() => setShowLogs(!showLogs)} className="mt-3 text-xs" style={{ color: "#555" }}>
                      {showLogs ? "Hide" : "Show"} logs
                    </button>
                  )}
                </div>
              )}

              {showLogs && (
                <div className="mb-6 p-3 font-mono text-xs overflow-auto max-h-48" style={{ background: "#050505", border: "1px solid #1a1a1a", color: "#666" }}>
                  {logs.length === 0 ? "Waiting for logs…" : logs.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}

              {needsHf && (
                <div className="mb-4 p-4" style={{ border: "1px solid rgba(204,255,0,0.3)", background: "rgba(204,255,0,0.03)" }}>
                  <div className="text-xs mb-2" style={{ color: "#ccff00" }}>Hugging Face token required for {needsHf}</div>
                  <div className="flex gap-2">
                    <input value={hfToken} onChange={e => setHfToken(e.target.value)} placeholder="hf_..."
                      className="flex-1 px-3 py-1.5 text-xs font-mono focus:outline-none"
                      style={{ background: "#0a0a0a", border: "1px solid #333", color: "#e8e8e8" }} />
                    <button onClick={() => deployModel(needsHf)}
                      className="px-3 py-1.5 text-xs font-bold" style={{ background: "#ccff00", color: "#000" }}>Deploy</button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {models.map(m => (
                  <div key={m.id} className="flex items-center gap-3 p-3" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold" style={{ color: "#e8e8e8" }}>{m.name}</span>
                        {!m.no_auth && <span className="text-[10px] px-1 border" style={{ borderColor: "#333", color: "#555" }}>HF token</span>}
                        {setupStatus?.model === m.id && setupStatus.status === "running" && (
                          <span className="text-[10px] px-1.5 py-0.5" style={{ background: "rgba(0,230,118,0.1)", color: "#00e676", border: "1px solid rgba(0,230,118,0.3)" }}>active</span>
                        )}
                      </div>
                      <div className="text-xs font-mono" style={{ color: "#444" }}>{m.id}</div>
                    </div>
                    <div className="text-xs text-right shrink-0" style={{ color: "#555" }}>
                      <div>{m.params}</div>
                      <div style={{ color: m.vram_gb >= 40 ? "#ff4757" : m.vram_gb >= 16 ? "#ccff00" : "#00e676" }}>{m.vram_gb}GB</div>
                    </div>
                    <button
                      onClick={() => { setNeedsHf(null); deployModel(m.id); }}
                      disabled={!!deployingModel || setupStatus?.status === "pulling" || setupStatus?.status === "starting"}
                      className="text-xs px-3 py-1.5 shrink-0 transition-all"
                      style={{
                        background: setupStatus?.model === m.id && setupStatus.status === "running" ? "rgba(0,230,118,0.1)" : "transparent",
                        border: `1px solid ${setupStatus?.model === m.id && setupStatus.status === "running" ? "rgba(0,230,118,0.4)" : "#2a2a2a"}`,
                        color: setupStatus?.model === m.id && setupStatus.status === "running" ? "#00e676" : "#888",
                        cursor: deployingModel ? "not-allowed" : "pointer",
                      }}>
                      {deployingModel === m.id ? "…" : setupStatus?.model === m.id && setupStatus.status === "running" ? "running" : "deploy"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* KEYS TAB */}
          {tab === "keys" && (
            <div>
              <div className="mb-6 p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                <div className="text-xs font-bold mb-3" style={{ color: "#ccff00" }}>Create API key</div>
                <div className="flex gap-3 flex-wrap items-end">
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "#555" }}>Name</label>
                    <input value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="my-app"
                      className="px-3 py-1.5 text-sm focus:outline-none w-40"
                      style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                  </div>
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "#555" }}>Email (optional)</label>
                    <input value={newKeyEmail} onChange={e => setNewKeyEmail(e.target.value)} placeholder="user@example.com"
                      className="px-3 py-1.5 text-sm focus:outline-none w-52"
                      style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                  </div>
                  <button onClick={createKey} disabled={!newKeyName}
                    className="px-4 py-1.5 text-sm font-bold transition-all"
                    style={{ background: newKeyName ? "#ccff00" : "#1a1a1a", color: newKeyName ? "#000" : "#444", cursor: newKeyName ? "pointer" : "not-allowed" }}>
                    + Create key
                  </button>
                </div>
              </div>

              {createdKey && (
                <div className="mb-4 p-4" style={{ border: "1px solid rgba(204,255,0,0.4)", background: "rgba(204,255,0,0.04)" }}>
                  <div className="text-xs mb-1 font-bold" style={{ color: "#ccff00" }}>New key — copy it now, it won&apos;t be shown again:</div>
                  <div className="flex items-center gap-3">
                    <code className="font-mono text-xs flex-1 break-all" style={{ color: "#e8e8e8" }}>{createdKey}</code>
                    <button onClick={() => navigator.clipboard?.writeText(createdKey)}
                      className="text-xs px-2 py-1 shrink-0" style={{ border: "1px solid rgba(204,255,0,0.4)", color: "#ccff00" }}>copy</button>
                    <button onClick={() => setCreatedKey("")} className="text-xs" style={{ color: "#555" }}>×</button>
                  </div>
                </div>
              )}

              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e1e1e", color: "#444", fontSize: "11px" }}>
                    <th className="text-left py-2 pr-4">Prefix</th>
                    <th className="text-left py-2 pr-4">Name</th>
                    <th className="text-left py-2 pr-4">Owner</th>
                    <th className="text-left py-2 pr-4">Last used</th>
                    <th className="text-left py-2 pr-4">Status</th>
                    <th className="text-left py-2" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map(k => (
                    <tr key={k.id} style={{ borderBottom: "1px solid #111" }}>
                      <td className="py-2 pr-4 font-mono text-xs" style={{ color: "#888" }}>{k.prefix}…</td>
                      <td className="py-2 pr-4 text-xs">{k.name ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs" style={{ color: "#555" }}>{k.owner_email ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs" style={{ color: "#444" }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}</td>
                      <td className="py-2 pr-4 text-xs">
                        <span style={{ color: k.active ? "#00e676" : "#444" }}>{k.active ? "active" : "inactive"}</span>
                      </td>
                      <td className="py-2 flex gap-2">
                        {k.raw_key && (
                          <button onClick={() => navigator.clipboard?.writeText(k.raw_key!)}
                            className="text-xs px-2 py-0.5" style={{ border: "1px solid #2a2a2a", color: "#666" }}>copy</button>
                        )}
                        <button onClick={() => toggleKey(k.id, k.active)}
                          className="text-xs px-2 py-0.5" style={{ border: "1px solid #2a2a2a", color: "#666" }}>
                          {k.active ? "disable" : "enable"}
                        </button>
                        <button onClick={() => deleteKey(k.id)}
                          className="text-xs px-2 py-0.5" style={{ border: "1px solid rgba(255,71,87,0.3)", color: "#ff4757" }}>del</button>
                      </td>
                    </tr>
                  ))}
                  {keys.length === 0 && (
                    <tr><td colSpan={6} className="py-8 text-center text-xs" style={{ color: "#333" }}>No API keys yet — create one above</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* REQUESTS TAB */}
          {tab === "requests" && (
            <div>
              <div className="text-xs mb-3" style={{ color: "#444" }}>Last 50 requests</div>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e1e1e", color: "#444", fontSize: "11px" }}>
                    <th className="text-left py-2 pr-3">Time</th>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">Model</th>
                    <th className="text-left py-2 pr-3">Key</th>
                    <th className="text-right py-2 pr-3">Latency</th>
                    <th className="text-right py-2 pr-3">Tok in</th>
                    <th className="text-right py-2 pr-3">Tok out</th>
                    <th className="text-left py-2">Prompt</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #111" }}>
                      <td className="py-1.5 pr-3 text-xs" style={{ color: "#444" }}>{new Date(r.created_at).toLocaleTimeString()}</td>
                      <td className="py-1.5 pr-3 text-xs" style={{ color: r.status === "completed" ? "#00e676" : r.status === "failed" ? "#ff4757" : "#888" }}>{r.status}</td>
                      <td className="py-1.5 pr-3 text-xs font-mono" style={{ color: "#666" }}>{r.model.split("/").pop()}</td>
                      <td className="py-1.5 pr-3 text-xs font-mono" style={{ color: "#555" }}>{r.key_name ?? r.key_prefix ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-xs text-right font-mono" style={{ color: "#555" }}>{r.latency_ms ? `${r.latency_ms}ms` : "—"}</td>
                      <td className="py-1.5 pr-3 text-xs text-right font-mono" style={{ color: "#555" }}>{r.tokens_in ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-xs text-right font-mono" style={{ color: "#ccff00" }}>{r.tokens_out ?? "—"}</td>
                      <td className="py-1.5 text-xs" style={{ color: "#444", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.prompt_preview ?? "—"}</td>
                    </tr>
                  ))}
                  {requests.length === 0 && (
                    <tr><td colSpan={8} className="py-8 text-center text-xs" style={{ color: "#333" }}>No requests yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* SETTINGS TAB */}
          {tab === "settings" && (
            <div className="flex flex-col gap-6 max-w-md">
              <div className="p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                <div className="text-xs font-bold mb-3" style={{ color: "#ccff00" }}>Change password</div>
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "#555" }}>Current password</label>
                    <input type="password" value={curPw} onChange={e => setCurPw(e.target.value)}
                      className="w-full px-3 py-2 text-sm focus:outline-none"
                      style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                  </div>
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "#555" }}>New password (8+ chars)</label>
                    <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                      className="w-full px-3 py-2 text-sm focus:outline-none"
                      style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                  </div>
                  <button onClick={changePassword} disabled={!curPw || newPw.length < 8}
                    className="px-4 py-2 text-sm font-bold transition-all"
                    style={{ background: curPw && newPw.length >= 8 ? "#ccff00" : "#1a1a1a", color: curPw && newPw.length >= 8 ? "#000" : "#444", cursor: curPw && newPw.length >= 8 ? "pointer" : "not-allowed" }}>
                    Update password
                  </button>
                  {pwMsg && <div className="text-xs" style={{ color: pwMsg.includes("updated") ? "#00e676" : "#ff4757" }}>{pwMsg}</div>}
                </div>
              </div>

              <div className="p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                <div className="text-xs font-bold mb-2" style={{ color: "#ccff00" }}>Tunnel info</div>
                {setupStatus?.tunnel_url ? (
                  <div>
                    <code className="text-xs font-mono" style={{ color: "#888" }}>{setupStatus.tunnel_url}</code>
                    <div className="text-xs mt-2" style={{ color: "#444" }}>
                      Use this URL + an API key to access your inference endpoint from anywhere
                    </div>
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: "#444" }}>
                    No tunnel active. The deploy-locally.sh script starts a Cloudflare tunnel automatically.
                    Restart it to get a new tunnel URL.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <Footer />
    </>
  );
}
