"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { toast } from "@/lib/toast";

type Tab = "models" | "keys" | "requests" | "settings";

interface ApiKey {
  id: string; prefix: string; raw_key: string | null; name: string | null;
  owner_email: string | null; active: number; scopes: string;
  created_at: string; last_used_at: string | null;
}
interface Request {
  id: string; model: string; status: string; tokens_in: number | null;
  tokens_out: number | null; latency_ms: number | null; prompt_preview: string | null;
  created_at: string; key_prefix: string | null; key_name: string | null;
}
interface RequestDetail {
  id: string; model: string; status: string;
  tokens_in: number | null; tokens_out: number | null; latency_ms: number | null;
  prompt_full: string | null; prompt_preview: string | null;
  response_content: string | null; error: string | null; created_at: string;
  key_prefix: string | null; key_name: string | null; key_email: string | null;
}
interface SetupStatus {
  status: string; model: string | null; error: string | null;
  gpu_util: string | null; tunnel_url: string | null;
}
interface Model { id: string; name: string; params: string; vram_gb: number; tags: string[]; no_auth: boolean; }

// ── Tooltip wrapper ───────────────────────────────────────────────────────────
function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  const [vis, setVis] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setVis(true)} onMouseLeave={() => setVis(false)}>
      {children}
      {vis && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)", whiteSpace: "nowrap",
          background: "#1a1a1a", border: "1px solid #2a2a2a",
          color: "#aaa", fontSize: "11px", padding: "3px 8px",
          pointerEvents: "none", zIndex: 100,
        }}>{label}</span>
      )}
    </span>
  );
}

// ── Request detail modal ──────────────────────────────────────────────────────
function RequestModal({ req, onClose }: { req: RequestDetail; onClose: () => void }) {
  const tps = req.tokens_out && req.latency_ms
    ? (req.tokens_out / (req.latency_ms / 1000)).toFixed(1)
    : null;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", width: "100%", maxWidth: "680px", maxHeight: "85vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #1a1a1a" }}>
          <div>
            <div className="text-sm font-bold" style={{ color: "#ccff00" }}>Request detail</div>
            <div className="text-xs font-mono mt-0.5" style={{ color: "#444" }}>{req.id}</div>
          </div>
          <button onClick={onClose} style={{ color: "#555", fontSize: "18px", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Metrics grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
            {[
              { label: "status",  value: req.status, color: req.status === "completed" ? "#00e676" : req.status === "failed" ? "#ff4757" : "#888" },
              { label: "model",   value: req.model.split("/").pop() ?? req.model },
              { label: "time",    value: new Date(req.created_at).toLocaleString() },
              { label: "latency", value: req.latency_ms ? `${req.latency_ms} ms` : "—" },
              { label: "tokens in",  value: req.tokens_in  ?? "—" },
              { label: "tokens out", value: req.tokens_out ?? "—" },
              ...(tps ? [{ label: "avg TPS", value: `${tps} tok/s`, color: "#ccff00" }] : []),
              ...(req.key_name || req.key_prefix ? [{ label: "api key", value: `${req.key_name ?? ""} (${req.key_prefix ?? ""}…)` }] : []),
            ].map(m => (
              <div key={m.label} style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", padding: "10px 12px" }}>
                <div style={{ fontSize: "10px", color: "#555", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{m.label}</div>
                <div style={{ fontSize: "13px", fontFamily: "var(--font-mono)", color: (m as { color?: string }).color ?? "#e8e8e8", wordBreak: "break-all" }}>
                  {String(m.value)}
                </div>
              </div>
            ))}
          </div>

          {/* Full prompt */}
          <div>
            <div style={{ fontSize: "11px", color: "#555", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Full prompt</div>
            <pre style={{
              background: "#050505", border: "1px solid #1a1a1a",
              padding: "12px", fontSize: "12px", color: "#999",
              fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap",
              wordBreak: "break-word", maxHeight: "200px", overflowY: "auto", margin: 0,
            }}>
              {req.prompt_full || req.prompt_preview || "—"}
            </pre>
          </div>

          {/* Response */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
              <div style={{ fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "0.06em" }}>Response</div>
              {req.response_content && (
                <button
                  onClick={() => { navigator.clipboard?.writeText(req.response_content!); toast("Response copied"); }}
                  style={{ fontSize: "11px", color: "#555", border: "1px solid #2a2a2a", padding: "2px 8px", background: "transparent", cursor: "pointer" }}>
                  copy
                </button>
              )}
            </div>
            <pre style={{
              background: "#050505", border: "1px solid #1a1a1a",
              padding: "12px", fontSize: "12px", color: "#aaa",
              fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap",
              wordBreak: "break-word", maxHeight: "260px", overflowY: "auto", margin: 0,
            }}>
              {req.response_content || (req.status === "failed" ? "(request failed)" : "(streaming or not yet captured)")}
            </pre>
          </div>

          {/* Error */}
          {req.error && (
            <div>
              <div style={{ fontSize: "11px", color: "#ff4757", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Error</div>
              <pre style={{
                background: "rgba(255,71,87,0.06)", border: "1px solid rgba(255,71,87,0.2)",
                padding: "12px", fontSize: "12px", color: "#ff4757",
                fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
              }}>
                {req.error}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main admin page ───────────────────────────────────────────────────────────
export default function AdminPage() {
  const router = useRouter();
  const [token,           setToken]          = useState<string | null>(null);
  const [tab,             setTab]            = useState<Tab>("models");
  const [refreshing,      setRefreshing]     = useState(false);

  const [keys,            setKeys]           = useState<ApiKey[]>([]);
  const [requests,        setRequests]       = useState<Request[]>([]);
  const [setupStatus,     setSetup]          = useState<SetupStatus | null>(null);
  const [models,          setModels]         = useState<Model[]>([]);
  const [requestDetail,   setRequestDetail]  = useState<RequestDetail | null>(null);
  const [loadingReqId,    setLoadingReqId]   = useState<string | null>(null);

  const [newKeyName,      setNewKeyName]     = useState("");
  const [newKeyEmail,     setNewKeyEmail]    = useState("");
  const [createdKey,      setCreatedKey]     = useState("");

  const [error,           setError]          = useState("");

  const [curPw,           setCurPw]          = useState("");
  const [newPw,           setNewPw]          = useState("");
  const [pwMsg,           setPwMsg]          = useState("");

  const [totpEnabled,     setTotpEnabled]    = useState(false);
  const [totpSetup,       setTotpSetup]      = useState<{ secret: string; otpauth: string } | null>(null);
  const [totpCode,        setTotpCode]       = useState("");
  const [totpMsg,         setTotpMsg]        = useState("");
  const [totpDisableCode, setTotpDisableCode]= useState("");

  const [deployingModel,  setDeployingModel] = useState("");
  const [hfToken,         setHfToken]        = useState("");
  const [needsHf,         setNeedsHf]        = useState<string | null>(null);
  const [showLogs,        setShowLogs]       = useState(false);
  const [logs,            setLogs]           = useState<string[]>([]);

  // button loading states for key actions
  const [keyBusy,         setKeyBusy]        = useState<Record<string, string>>({});

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

  const loadKeys       = useCallback(async () => { if (!token) return; try { const r = await af("/api/admin/keys"); const d = await r.json() as { keys: ApiKey[] }; setKeys(d.keys ?? []); } catch { /* silent */ } }, [token, af]);
  const loadRequests   = useCallback(async () => { if (!token) return; try { const r = await af("/api/admin/requests?limit=50"); const d = await r.json() as { requests: Request[] }; setRequests(d.requests ?? []); } catch { /* silent */ } }, [token, af]);
  const loadSetup      = useCallback(async () => { try { const r = await fetch("/api/setup/status"); setSetup(await r.json() as SetupStatus); } catch { /* silent */ } }, []);
  const loadModels     = useCallback(async () => { try { const r = await fetch("/api/setup/models"); const d = await r.json() as { models: Model[] }; setModels(d.models ?? []); } catch { /* silent */ } }, []);
  const loadTotpStatus = useCallback(async () => { if (!token) return; try { const r = await af("/api/admin/2fa/status"); const d = await r.json() as { enabled: boolean }; setTotpEnabled(d.enabled); } catch { /* silent */ } }, [token, af]);

  useEffect(() => {
    if (!token) return;
    loadKeys(); loadRequests(); loadSetup(); loadModels(); loadTotpStatus();
  }, [token, loadKeys, loadRequests, loadSetup, loadModels, loadTotpStatus]);

  useEffect(() => {
    if (!["pulling", "starting"].includes(setupStatus?.status ?? "")) return;
    const t = setInterval(loadSetup, 4000); return () => clearInterval(t);
  }, [setupStatus?.status, loadSetup]);

  useEffect(() => {
    if (!showLogs || !token) return;
    let alive = true; setLogs([]);
    (async () => {
      try {
        const res = await af("/api/setup/logs");
        const reader = res.body!.getReader(); const dec = new TextDecoder();
        while (alive) {
          const { value, done } = await reader.read(); if (done) break;
          for (const ev of dec.decode(value).split("\n\n").filter(Boolean)) {
            try { const d = JSON.parse(ev.replace(/^data: /, "")) as { line: string }; setLogs(p => [...p.slice(-200), d.line]); } catch { /* skip */ }
          }
        }
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [showLogs, token, af]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadKeys(), loadRequests(), loadSetup(), loadModels(), loadTotpStatus()]);
    setRefreshing(false);
    toast("Refreshed", "info");
  };

  // Open request detail modal
  const openRequest = async (id: string) => {
    setLoadingReqId(id);
    try {
      const r = await af(`/api/admin/requests/${id}`);
      const d = await r.json() as { request?: RequestDetail; error?: string };
      if (!r.ok || !d.request) { toast(d.error ?? "Failed to load request", "err"); return; }
      setRequestDetail(d.request);
    } catch (e) { toast(e instanceof Error ? e.message : "Error", "err"); }
    finally { setLoadingReqId(null); }
  };

  // Key actions
  const createKey = async () => {
    if (!newKeyName) return;
    try {
      const r = await af("/api/admin/keys", { method: "POST", body: JSON.stringify({ name: newKeyName, owner_email: newKeyEmail, scopes: ["chat"] }) });
      if (!r.ok) { toast("Failed to create key", "err"); return; }
      const d = await r.json() as { key?: string };
      if (d.key) setCreatedKey(d.key);
      setNewKeyName(""); setNewKeyEmail("");
      await loadKeys();
      toast("API key created", "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Error", "err"); }
  };

  const deleteKey = async (id: string, name: string | null) => {
    if (!confirm(`Delete key "${name ?? id}"?`)) return;
    setKeyBusy(p => ({ ...p, [id]: "deleting" }));
    try {
      const r = await af(`/api/admin/keys/${id}`, { method: "DELETE" });
      if (!r.ok) { toast("Delete failed", "err"); return; }
      await loadKeys();
      toast("Key deleted", "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Error", "err"); }
    finally { setKeyBusy(p => { const n = { ...p }; delete n[id]; return n; }); }
  };

  const toggleKey = async (id: string, active: number, name: string | null) => {
    setKeyBusy(p => ({ ...p, [id]: "toggling" }));
    try {
      const r = await af(`/api/admin/keys/${id}`, { method: "PATCH", body: JSON.stringify({ active: !active }) });
      if (!r.ok) { toast("Update failed", "err"); return; }
      await loadKeys();
      toast(`Key ${active ? "disabled" : "enabled"}: ${name ?? id.slice(0, 8)}`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Error", "err"); }
    finally { setKeyBusy(p => { const n = { ...p }; delete n[id]; return n; }); }
  };

  const copyKey = (raw: string, name: string | null) => {
    if (!navigator.clipboard) { toast("Clipboard not available (need HTTPS)", "err"); return; }
    navigator.clipboard.writeText(raw)
      .then(() => toast(`Copied: ${name ?? "key"}`, "ok"))
      .catch(() => toast("Copy failed", "err"));
  };

  const changePassword = async () => {
    setPwMsg("");
    try {
      const r = await af("/api/admin/password", { method: "POST", body: JSON.stringify({ current: curPw, new: newPw }) });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (d.ok) { setPwMsg("Password updated."); setCurPw(""); setNewPw(""); toast("Password updated", "ok"); }
      else { setPwMsg(d.error ?? "Failed"); toast(d.error ?? "Failed", "err"); }
    } catch (e) { setPwMsg(String(e)); toast(String(e), "err"); }
  };

  const setup2fa = async () => {
    setTotpMsg(""); setTotpCode("");
    try {
      const r = await af("/api/admin/2fa/setup", { method: "POST" });
      const d = await r.json() as { secret?: string; otpauth?: string; error?: string };
      if (d.error) { setTotpMsg(d.error); toast(d.error, "err"); return; }
      setTotpSetup({ secret: d.secret!, otpauth: d.otpauth! });
    } catch (e) { toast(String(e), "err"); }
  };

  const enable2fa = async () => {
    setTotpMsg("");
    try {
      const r = await af("/api/admin/2fa/enable", { method: "POST", body: JSON.stringify({ code: totpCode }) });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (d.error) { setTotpMsg(d.error); toast(d.error, "err"); return; }
      setTotpEnabled(true); setTotpSetup(null); setTotpCode(""); setTotpMsg("2FA enabled."); toast("2FA enabled", "ok");
    } catch (e) { toast(String(e), "err"); }
  };

  const disable2fa = async () => {
    setTotpMsg("");
    try {
      const r = await af("/api/admin/2fa/disable", { method: "POST", body: JSON.stringify({ code: totpDisableCode }) });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (d.error) { setTotpMsg(d.error); toast(d.error, "err"); return; }
      setTotpEnabled(false); setTotpSetup(null); setTotpDisableCode(""); setTotpMsg("2FA disabled."); toast("2FA disabled", "ok");
    } catch (e) { toast(String(e), "err"); }
  };

  const deployModel = async (modelId: string) => {
    setError(""); setDeployingModel(modelId); setNeedsHf(null);
    try {
      const r = await af("/api/setup/deploy", { method: "POST", body: JSON.stringify({ model: modelId, hf_token: hfToken || undefined }) });
      const d = await r.json() as { error?: string; needs_hf_token?: boolean; ok?: boolean };
      if (d.needs_hf_token) { setNeedsHf(modelId); setDeployingModel(""); return; }
      if (d.error) { setError(d.error); toast(d.error, "err"); setDeployingModel(""); return; }
      toast(`Deploying ${modelId.split("/").pop()}…`, "info");
      loadSetup();
    } catch (e) { setError(String(e)); toast(String(e), "err"); }
    finally { if (!needsHf) setDeployingModel(""); }
  };

  const stopModel = async () => {
    await af("/api/setup/stop", { method: "POST" });
    loadSetup();
    toast("Model stopped", "ok");
  };

  if (!token) return null;

  const S: Record<string, string> = { running: "#00e676", error: "#ff4757", pulling: "#ccff00", starting: "#ccff00", idle: "#444" };
  const deployBusy = !!deployingModel || ["pulling", "starting"].includes(setupStatus?.status ?? "");

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

          {error && (
            <div className="mb-4 p-3 text-sm" style={{ background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", color: "#ff4757" }}>
              {error}<button onClick={() => setError("")} className="ml-3" style={{ color: "#ff4757" }}>×</button>
            </div>
          )}

          {/* Tabs */}
          <div style={{ borderBottom: "1px solid #1e1e1e" }} className="flex gap-1 mb-6">
            {(["models", "keys", "requests", "settings"] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className="px-3 pb-2 pt-1 text-sm capitalize transition-colors"
                style={{ color: tab === t ? "#ccff00" : "#555", borderBottom: tab === t ? "2px solid #ccff00" : "2px solid transparent" }}>
                {t}
              </button>
            ))}
            <Tip label="Reload all data">
              <button onClick={refresh} disabled={refreshing} className="ml-auto pb-2 text-xs transition-colors"
                style={{ color: refreshing ? "#ccff00" : "#444" }}>
                {refreshing ? "⋯" : "↻"} refresh
              </button>
            </Tip>
          </div>

          {/* ── MODELS ── */}
          {tab === "models" && (
            <div>
              {setupStatus && (
                <div className="mb-6 p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: S[setupStatus.status] ?? "#444" }} />
                    <span className="text-sm font-bold" style={{ color: S[setupStatus.status] ?? "#888" }}>{setupStatus.status}</span>
                    {setupStatus.model && <span className="text-xs font-mono" style={{ color: "#666" }}>{setupStatus.model}</span>}
                    {setupStatus.status === "running" && (
                      <Tip label="Stop the running model">
                        <button onClick={stopModel} className="ml-auto text-xs px-2 py-1"
                          style={{ border: "1px solid rgba(255,71,87,0.4)", color: "#ff4757", cursor: "pointer" }}>
                          Stop model
                        </button>
                      </Tip>
                    )}
                  </div>
                  {setupStatus.error && <div className="text-xs mt-1" style={{ color: "#ff4757" }}>{setupStatus.error}</div>}
                  {["pulling", "starting"].includes(setupStatus.status) && (
                    <button onClick={() => setShowLogs(!showLogs)} className="mt-3 text-xs" style={{ color: "#555" }}>
                      {showLogs ? "Hide" : "Show"} logs
                    </button>
                  )}
                </div>
              )}
              {showLogs && (
                <div className="mb-6 p-3 font-mono text-xs overflow-auto max-h-48"
                  style={{ background: "#050505", border: "1px solid #1a1a1a", color: "#666" }}>
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
                      className="px-3 py-1.5 text-xs font-bold" style={{ background: "#ccff00", color: "#000", cursor: "pointer" }}>Deploy</button>
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2">
                {models.map(m => {
                  const isActive = setupStatus?.model === m.id && setupStatus.status === "running";
                  const isDeploying = deployingModel === m.id;
                  return (
                    <div key={m.id} className="flex items-center gap-3 p-3"
                      style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-semibold" style={{ color: "#e8e8e8" }}>{m.name}</span>
                          {!m.no_auth && <span className="text-[10px] px-1 border" style={{ borderColor: "#333", color: "#555" }}>HF token</span>}
                          {isActive && <span className="text-[10px] px-1.5 py-0.5"
                            style={{ background: "rgba(0,230,118,0.1)", color: "#00e676", border: "1px solid rgba(0,230,118,0.3)" }}>active</span>}
                        </div>
                        <div className="text-xs font-mono" style={{ color: "#444" }}>{m.id}</div>
                      </div>
                      <div className="text-xs text-right shrink-0" style={{ color: "#555" }}>
                        <div>{m.params}</div>
                        <div style={{ color: m.vram_gb >= 40 ? "#ff4757" : m.vram_gb >= 16 ? "#ccff00" : "#00e676" }}>{m.vram_gb}GB</div>
                      </div>
                      <Tip label={isActive ? "Already running" : deployBusy && !isDeploying ? "Another deployment in progress" : `Deploy ${m.name}`}>
                        <button
                          onClick={() => { if (isActive || deployBusy) return; setNeedsHf(null); deployModel(m.id); }}
                          disabled={deployBusy}
                          style={{
                            fontSize: "12px", padding: "5px 12px", cursor: isActive || deployBusy ? "not-allowed" : "pointer",
                            background: isActive ? "rgba(0,230,118,0.1)" : "transparent",
                            border: `1px solid ${isActive ? "rgba(0,230,118,0.4)" : "#2a2a2a"}`,
                            color: isActive ? "#00e676" : isDeploying ? "#ccff00" : "#888",
                            transition: "all 0.15s",
                          }}>
                          {isDeploying ? "⋯" : isActive ? "running" : "deploy"}
                        </button>
                      </Tip>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── KEYS ── */}
          {tab === "keys" && (
            <div>
              <div className="mb-6 p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                <div className="text-xs font-bold mb-3" style={{ color: "#ccff00" }}>Create API key</div>
                <div className="flex gap-3 flex-wrap items-end">
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "#555" }}>Name</label>
                    <input value={newKeyName} onChange={e => setNewKeyName(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && createKey()}
                      placeholder="my-app"
                      className="px-3 py-1.5 text-sm focus:outline-none w-40"
                      style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                  </div>
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "#555" }}>Email (optional)</label>
                    <input value={newKeyEmail} onChange={e => setNewKeyEmail(e.target.value)} placeholder="alice@example.com"
                      className="px-3 py-1.5 text-sm focus:outline-none w-52"
                      style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                  </div>
                  <Tip label={newKeyName ? "Create this API key" : "Enter a name first"}>
                    <button onClick={createKey} disabled={!newKeyName}
                      className="px-4 py-1.5 text-sm font-bold"
                      style={{ background: newKeyName ? "#ccff00" : "#1a1a1a", color: newKeyName ? "#000" : "#444", cursor: newKeyName ? "pointer" : "not-allowed", transition: "all 0.15s" }}>
                      + Create key
                    </button>
                  </Tip>
                </div>
              </div>

              {createdKey && (
                <div className="mb-4 p-4" style={{ border: "1px solid rgba(204,255,0,0.4)", background: "rgba(204,255,0,0.04)" }}>
                  <div className="text-xs mb-1 font-bold" style={{ color: "#ccff00" }}>New key — copy it now, it won&apos;t be shown again:</div>
                  <div className="flex items-center gap-3">
                    <code className="font-mono text-xs flex-1 break-all" style={{ color: "#e8e8e8" }}>{createdKey}</code>
                    <button onClick={() => { navigator.clipboard?.writeText(createdKey); toast("Key copied", "ok"); }}
                      className="text-xs px-2 py-1 shrink-0" style={{ border: "1px solid rgba(204,255,0,0.4)", color: "#ccff00", cursor: "pointer" }}>copy</button>
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
                  {keys.map(k => {
                    const busy = !!keyBusy[k.id];
                    return (
                      <tr key={k.id} style={{ borderBottom: "1px solid #111" }}>
                        <td className="py-2 pr-4 font-mono text-xs" style={{ color: "#888" }}>{k.prefix}…</td>
                        <td className="py-2 pr-4 text-xs">{k.name ?? "—"}</td>
                        <td className="py-2 pr-4 text-xs" style={{ color: "#555" }}>{k.owner_email ?? "—"}</td>
                        <td className="py-2 pr-4 text-xs" style={{ color: "#444" }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}</td>
                        <td className="py-2 pr-4 text-xs"><span style={{ color: k.active ? "#00e676" : "#444" }}>{k.active ? "active" : "inactive"}</span></td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            {k.raw_key && (
                              <Tip label="Copy API key to clipboard">
                                <button
                                  onClick={() => copyKey(k.raw_key!, k.name)}
                                  style={{ fontSize: "11px", padding: "2px 8px", border: "1px solid #2a2a2a", color: "#888", background: "transparent", cursor: "pointer", transition: "color 0.15s" }}
                                  onMouseOver={e => { e.currentTarget.style.color = "#ccff00"; e.currentTarget.style.borderColor = "rgba(204,255,0,0.4)"; }}
                                  onMouseOut={e => { e.currentTarget.style.color = "#888"; e.currentTarget.style.borderColor = "#2a2a2a"; }}>
                                  {busy && keyBusy[k.id] === "toggling" ? "⋯" : "copy"}
                                </button>
                              </Tip>
                            )}
                            <Tip label={k.active ? "Disable this key (requests will be rejected)" : "Re-enable this key"}>
                              <button
                                onClick={() => toggleKey(k.id, k.active, k.name)}
                                disabled={busy}
                                style={{ fontSize: "11px", padding: "2px 8px", border: "1px solid #2a2a2a", color: busy ? "#ccff00" : "#888", background: "transparent", cursor: busy ? "not-allowed" : "pointer", transition: "color 0.15s" }}
                                onMouseOver={e => { if (!busy) e.currentTarget.style.color = "#e8e8e8"; }}
                                onMouseOut={e => { if (!busy) e.currentTarget.style.color = "#888"; }}>
                                {busy && keyBusy[k.id] === "toggling" ? "⋯" : k.active ? "disable" : "enable"}
                              </button>
                            </Tip>
                            <Tip label="Permanently delete this key">
                              <button
                                onClick={() => deleteKey(k.id, k.name)}
                                disabled={busy}
                                style={{ fontSize: "11px", padding: "2px 8px", border: "1px solid rgba(255,71,87,0.3)", color: busy ? "#ccff00" : "#ff4757", background: "transparent", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}>
                                {busy && keyBusy[k.id] === "deleting" ? "⋯" : "del"}
                              </button>
                            </Tip>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {keys.length === 0 && (
                    <tr><td colSpan={6} className="py-8 text-center text-xs" style={{ color: "#333" }}>No API keys yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ── REQUESTS ── */}
          {tab === "requests" && (
            <div>
              <div className="text-xs mb-3" style={{ color: "#444" }}>Last 50 requests — click a row for full details</div>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e1e1e", color: "#444", fontSize: "11px" }}>
                    <th className="text-left py-2 pr-3">Time</th>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">Model</th>
                    <th className="text-left py-2 pr-3">Key</th>
                    <th className="text-right py-2 pr-3">ms</th>
                    <th className="text-right py-2 pr-3">TPS</th>
                    <th className="text-right py-2 pr-3">In</th>
                    <th className="text-right py-2 pr-3">Out</th>
                    <th className="text-left py-2">Prompt</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map(r => {
                    const tps = r.tokens_out && r.latency_ms
                      ? (r.tokens_out / (r.latency_ms / 1000)).toFixed(1)
                      : null;
                    const isLoading = loadingReqId === r.id;
                    return (
                      <tr key={r.id}
                        onClick={() => openRequest(r.id)}
                        style={{ borderBottom: "1px solid #111", cursor: "pointer", opacity: isLoading ? 0.6 : 1, transition: "background 0.1s" }}
                        onMouseOver={e => { (e.currentTarget as HTMLTableRowElement).style.background = "#0f0f0f"; }}
                        onMouseOut={e => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}>
                        <td className="py-1.5 pr-3 text-xs" style={{ color: "#444" }}>{new Date(r.created_at).toLocaleTimeString()}</td>
                        <td className="py-1.5 pr-3 text-xs"
                          style={{ color: r.status === "completed" ? "#00e676" : r.status === "failed" ? "#ff4757" : "#888" }}>
                          {isLoading ? "⋯" : r.status}
                        </td>
                        <td className="py-1.5 pr-3 text-xs font-mono" style={{ color: "#666" }}>{r.model.split("/").pop()}</td>
                        <td className="py-1.5 pr-3 text-xs font-mono" style={{ color: "#555" }}>{r.key_name ?? r.key_prefix ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-xs text-right font-mono" style={{ color: "#555" }}>{r.latency_ms ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-xs text-right font-mono" style={{ color: tps ? "#ccff00" : "#333" }}>{tps ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-xs text-right font-mono" style={{ color: "#555" }}>{r.tokens_in ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-xs text-right font-mono" style={{ color: "#888" }}>{r.tokens_out ?? "—"}</td>
                        <td className="py-1.5 text-xs" style={{ color: "#444", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.prompt_preview ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {requests.length === 0 && (
                    <tr><td colSpan={9} className="py-8 text-center text-xs" style={{ color: "#333" }}>No requests yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ── SETTINGS ── */}
          {tab === "settings" && (
            <div className="flex flex-col gap-6 max-w-md">
              {/* Tunnel */}
              <div className="p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                <div className="text-xs font-bold mb-3" style={{ color: "#ccff00" }}>Cloudflare tunnel</div>
                {setupStatus?.tunnel_url ? (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#00e676", boxShadow: "0 0 5px #00e676" }} />
                      <span className="text-xs" style={{ color: "#00e676" }}>Active</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs flex-1 truncate" style={{ color: "#aaa" }}>{setupStatus.tunnel_url}</code>
                      <Tip label="Copy tunnel URL">
                        <button onClick={() => { navigator.clipboard?.writeText(setupStatus.tunnel_url!); toast("Tunnel URL copied", "ok"); }}
                          style={{ fontSize: "11px", padding: "2px 8px", border: "1px solid rgba(204,255,0,0.3)", color: "#ccff00", background: "transparent", cursor: "pointer" }}>
                          copy
                        </button>
                      </Tip>
                    </div>
                    <div className="text-xs mt-2" style={{ color: "#444" }}>
                      Use <code style={{ color: "#666" }}>{setupStatus.tunnel_url}/v1</code> as your API base URL from any device.
                    </div>
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: "#555" }}>
                    No tunnel active. Run <code style={{ color: "#666" }}>bash deploy-locally.sh</code> — it starts a Cloudflare Quick Tunnel automatically.
                  </div>
                )}
              </div>

              {/* Password */}
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
                      onKeyDown={e => e.key === "Enter" && changePassword()}
                      className="w-full px-3 py-2 text-sm focus:outline-none"
                      style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                  </div>
                  <Tip label={curPw && newPw.length >= 8 ? "Save new password" : "Fill in both fields (8+ char new password)"}>
                    <button onClick={changePassword} disabled={!curPw || newPw.length < 8}
                      style={{
                        padding: "8px 16px", fontSize: "14px", fontWeight: 700,
                        background: curPw && newPw.length >= 8 ? "#ccff00" : "#1a1a1a",
                        color: curPw && newPw.length >= 8 ? "#000" : "#444",
                        cursor: curPw && newPw.length >= 8 ? "pointer" : "not-allowed",
                        border: "none", transition: "all 0.15s",
                      }}>
                      Update password
                    </button>
                  </Tip>
                  {pwMsg && <div className="text-xs" style={{ color: pwMsg.includes("updated") ? "#00e676" : "#ff4757" }}>{pwMsg}</div>}
                </div>
              </div>

              {/* 2FA */}
              <div className="p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs font-bold" style={{ color: "#ccff00" }}>Two-factor authentication</div>
                  <span className="text-xs px-2 py-0.5"
                    style={{
                      background: totpEnabled ? "rgba(0,230,118,0.1)" : "rgba(255,255,255,0.04)",
                      color: totpEnabled ? "#00e676" : "#555",
                      border: `1px solid ${totpEnabled ? "rgba(0,230,118,0.3)" : "#2a2a2a"}`,
                    }}>
                    {totpEnabled ? "enabled" : "disabled"}
                  </span>
                </div>
                {totpMsg && (
                  <div className="mb-3 text-xs"
                    style={{ color: totpMsg.includes("enabled") || totpMsg.includes("disabled") ? "#00e676" : "#ff4757" }}>
                    {totpMsg}
                  </div>
                )}
                {!totpEnabled && !totpSetup && (
                  <div>
                    <p className="text-xs mb-3" style={{ color: "#555" }}>
                      Require a one-time code on every login. Works with Authy, 1Password, Google Authenticator, etc.
                    </p>
                    <button onClick={setup2fa}
                      style={{ padding: "8px 16px", fontSize: "14px", fontWeight: 700, background: "#ccff00", color: "#000", border: "none", cursor: "pointer" }}>
                      Set up 2FA
                    </button>
                  </div>
                )}
                {totpSetup && !totpEnabled && (
                  <div className="flex flex-col gap-4">
                    <div>
                      <p className="text-xs mb-2" style={{ color: "#888" }}>1. Scan with your authenticator app:</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(totpSetup.otpauth)}`}
                        alt="2FA QR code" width={160} height={160}
                        style={{ imageRendering: "pixelated", border: "4px solid #fff", display: "block" }} />
                    </div>
                    <div>
                      <p className="text-xs mb-1" style={{ color: "#555" }}>Or enter the secret manually:</p>
                      <code className="text-xs font-mono break-all" style={{ color: "#888", letterSpacing: "0.1em" }}>{totpSetup.secret}</code>
                    </div>
                    <div>
                      <p className="text-xs mb-2" style={{ color: "#888" }}>2. Enter the 6-digit code to confirm:</p>
                      <div className="flex gap-2">
                        <input value={totpCode} onChange={e => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          onKeyDown={e => e.key === "Enter" && totpCode.length === 6 && enable2fa()}
                          placeholder="000000" maxLength={6} inputMode="numeric"
                          className="px-3 py-2 text-sm font-mono tracking-widest focus:outline-none w-32"
                          style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                        <button onClick={enable2fa} disabled={totpCode.length !== 6}
                          style={{ padding: "8px 16px", fontSize: "14px", fontWeight: 700, background: totpCode.length === 6 ? "#ccff00" : "#1a1a1a", color: totpCode.length === 6 ? "#000" : "#444", cursor: totpCode.length === 6 ? "pointer" : "not-allowed", border: "none", transition: "all 0.15s" }}>
                          Verify &amp; enable
                        </button>
                        <button onClick={() => { setTotpSetup(null); setTotpCode(""); setTotpMsg(""); }}
                          style={{ padding: "8px 12px", fontSize: "13px", color: "#555", background: "transparent", border: "none", cursor: "pointer" }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {totpEnabled && (
                  <div>
                    <p className="text-xs mb-3" style={{ color: "#555" }}>
                      2FA is active. Enter a code from your authenticator app to disable it.
                    </p>
                    <div className="flex gap-2">
                      <input value={totpDisableCode} onChange={e => setTotpDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        onKeyDown={e => e.key === "Enter" && totpDisableCode.length === 6 && disable2fa()}
                        placeholder="000000" maxLength={6} inputMode="numeric"
                        className="px-3 py-2 text-sm font-mono tracking-widest focus:outline-none w-32"
                        style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
                      <button onClick={disable2fa} disabled={totpDisableCode.length !== 6}
                        style={{ padding: "8px 16px", fontSize: "14px", fontWeight: 700, border: "1px solid rgba(255,71,87,0.4)", background: "transparent", color: totpDisableCode.length === 6 ? "#ff4757" : "#444", cursor: totpDisableCode.length === 6 ? "pointer" : "not-allowed", transition: "color 0.15s" }}>
                        Disable 2FA
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Request detail modal */}
      {requestDetail && (
        <RequestModal req={requestDetail} onClose={() => setRequestDetail(null)} />
      )}

      <Footer />
    </>
  );
}
