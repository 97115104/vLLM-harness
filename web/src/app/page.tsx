"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/navbar";
import type { Model } from "@/lib/api";

const TOP_5 = [
  "mistralai/Mistral-7B-Instruct-v0.3",
  "Qwen/Qwen2.5-7B-Instruct",
  "openai/gpt-oss-20b",
  "microsoft/Phi-4-mini-instruct",
  "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
];

type Status = {
  status: "idle" | "pulling" | "starting" | "running" | "error";
  model: string | null; error: string | null; gpu_util: string | null; tunnel_url: string | null;
};

function ModelCard({ model, selected, onSelect }: { model: Model; selected: boolean; onSelect: () => void }) {
  const vramColor = model.vram_gb >= 40 ? "#ff4757" : model.vram_gb >= 16 ? "#ccff00" : "#00e676";
  return (
    <button onClick={onSelect}
      className="text-left w-full transition-all duration-150"
      style={{
        background: selected ? "rgba(204,255,0,0.06)" : "#0f0f0f",
        border: `1px solid ${selected ? "rgba(204,255,0,0.4)" : "#1e1e1e"}`,
        padding: "16px",
        cursor: "pointer",
      }}>
      <div className="flex justify-between items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-sm" style={{ color: selected ? "#ccff00" : "#e8e8e8" }}>
              {model.name}
            </span>
            {!model.no_auth && (
              <span className="text-[10px] px-1.5 py-0.5 border" style={{ borderColor: "#444", color: "#666" }}>
                HF token
              </span>
            )}
          </div>
          <div className="text-xs mb-2" style={{ color: "#666" }}>{model.description}</div>
          <div className="flex gap-2 flex-wrap">
            {model.tags.map(t => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 border" style={{ borderColor: "#2a2a2a", color: "#555" }}>
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs font-mono mb-0.5" style={{ color: "#888" }}>{model.params}</div>
          <div className="text-xs" style={{ color: vramColor }}>{model.vram_gb}GB VRAM</div>
          <div className="text-[10px] mt-1" style={{ color: "#444" }}>{model.context_k}K ctx</div>
        </div>
      </div>
    </button>
  );
}

function SetupWizard({ onDeployed }: { onDeployed: () => void }) {
  const [models, setModels] = useState<Model[]>([]);
  const [selected, setSelected] = useState<string>(TOP_5[0]);
  const [showMore, setShowMore] = useState(false);
  const [hfToken, setHfToken] = useState("");
  const [needsToken, setNeedsToken] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState("");
  const [token] = useState(() => typeof window !== "undefined" ? localStorage.getItem("admin_token") ?? "" : "");

  useEffect(() => {
    fetch("/api/setup/models")
      .then(r => r.json())
      .then((d: { models: Model[] }) => setModels(d.models))
      .catch(() => {});
  }, []);

  const topModels  = models.filter(m => TOP_5.includes(m.id));
  const moreModels = models.filter(m => !TOP_5.includes(m.id));
  const sorted     = [...topModels.sort((a, b) => TOP_5.indexOf(a.id) - TOP_5.indexOf(b.id)), ...(showMore ? moreModels : [])];
  const selectedModel = models.find(m => m.id === selected);

  const deploy = async () => {
    setError(""); setDeploying(true);
    try {
      const res = await fetch("/api/setup/deploy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: selected, hf_token: hfToken || undefined }),
      });
      const d = await res.json() as { error?: string; needs_hf_token?: boolean };
      if (d.needs_hf_token) { setNeedsToken(true); setDeploying(false); return; }
      if (d.error) { setError(d.error); setDeploying(false); return; }
      onDeployed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed"); setDeploying(false);
    }
  };

  return (
    <div className="fade-in max-w-2xl mx-auto">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold mb-2" style={{ color: "#ccff00" }}>Inference Studio</h1>
        <p className="text-sm" style={{ color: "#666" }}>Select a model to deploy on your machine</p>
      </div>

      <div className="flex flex-col gap-2 mb-4">
        {sorted.map(m => (
          <ModelCard key={m.id} model={m} selected={selected === m.id} onSelect={() => { setSelected(m.id); setNeedsToken(false); }} />
        ))}
      </div>

      {!showMore && moreModels.length > 0 && (
        <button onClick={() => setShowMore(true)}
          className="w-full py-2 text-sm mb-6 transition-colors"
          style={{ border: "1px solid #1e1e1e", color: "#555" }}
          onMouseOver={e => (e.currentTarget.style.color = "#999")}
          onMouseOut={e => (e.currentTarget.style.color = "#555")}>
          View {moreModels.length} more models ↓
        </button>
      )}

      {needsToken && (
        <div className="mb-4 p-4" style={{ border: "1px solid rgba(204,255,0,0.3)", background: "rgba(204,255,0,0.04)" }}>
          <div className="text-xs mb-2" style={{ color: "#ccff00" }}>Hugging Face token required</div>
          <div className="text-xs mb-3" style={{ color: "#666" }}>
            This model requires accepting terms on{" "}
            <a href={`https://huggingface.co/${selected}`} target="_blank" rel="noopener"
              style={{ color: "#ccff00" }}>huggingface.co/{selected}</a>{" "}
            first, then paste your token below.
          </div>
          <input value={hfToken} onChange={e => setHfToken(e.target.value)}
            placeholder="hf_..."
            className="w-full px-3 py-2 text-sm font-mono focus:outline-none"
            style={{ background: "#0a0a0a", border: "1px solid #333", color: "#e8e8e8" }} />
        </div>
      )}

      {error && <div className="mb-4 p-3 text-sm" style={{ background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", color: "#ff4757" }}>{error}</div>}

      <button onClick={deploy} disabled={deploying}
        className="w-full py-3 font-bold text-sm transition-all"
        style={{
          background: deploying ? "rgba(204,255,0,0.1)" : "#ccff00",
          color: deploying ? "#ccff00" : "#000",
          border: deploying ? "1px solid rgba(204,255,0,0.3)" : "none",
          cursor: deploying ? "not-allowed" : "pointer",
        }}>
        {deploying ? "Starting deployment…" : `Deploy ${selectedModel?.name ?? "model"}`}
      </button>

      {!token && (
        <p className="text-xs mt-4 text-center" style={{ color: "#444" }}>
          <Link href="/admin/login" style={{ color: "#666" }}>Log in as admin</Link> to deploy models
        </p>
      )}
    </div>
  );
}

function DeployProgress({ status, onRunning }: { status: Status; onRunning: () => void }) {
  useEffect(() => {
    if (status.status === "running") onRunning();
  }, [status, onRunning]);

  const steps = [
    { key: "pulling",  label: "Pulling Docker image" },
    { key: "starting", label: "Starting vLLM engine" },
    { key: "running",  label: "Model ready" },
  ];
  const current = steps.findIndex(s => s.key === status.status);

  return (
    <div className="fade-in max-w-lg mx-auto text-center">
      <h2 className="text-xl font-bold mb-2" style={{ color: "#ccff00" }}>Deploying {status.model?.split("/").pop()}</h2>
      <p className="text-xs mb-8" style={{ color: "#555" }}>{status.model}</p>

      <div className="flex flex-col gap-3 mb-8 text-left">
        {steps.map((s, i) => {
          const done    = i < current || status.status === "running";
          const active  = s.key === status.status;
          return (
            <div key={s.key} className="flex items-center gap-3">
              <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs"
                style={{
                  background: done ? "#ccff00" : active ? "rgba(204,255,0,0.15)" : "#1a1a1a",
                  border: active ? "1px solid rgba(204,255,0,0.5)" : "none",
                  color: done ? "#000" : "#ccff00",
                }}>
                {done ? "✓" : active ? "⋯" : ""}
              </div>
              <span className="text-sm" style={{ color: done ? "#e8e8e8" : active ? "#ccff00" : "#444" }}>
                {s.label}
                {active && status.gpu_util && s.key === "starting" && (
                  <span className="text-xs ml-2" style={{ color: "#666" }}>
                    gpu_memory_utilization={status.gpu_util}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {status.error && (
        <div className="p-3 mb-4 text-sm text-left" style={{ background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", color: "#ff4757" }}>
          {status.error}
        </div>
      )}

      {status.status === "error" && (
        <button onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm" style={{ border: "1px solid #444", color: "#888" }}>
          Try again
        </button>
      )}

      <p className="text-xs mt-6" style={{ color: "#333" }}>
        Large models may take several minutes to download. This page will update automatically.
      </p>
    </div>
  );
}

function Dashboard({ status }: { status: Status }) {
  const [requests, setRequests] = useState<{ id: string; model: string; status: string; created_at: string; tokens_out: number | null }[]>([]);
  const token = typeof window !== "undefined" ? localStorage.getItem("admin_token") ?? "" : "";

  useEffect(() => {
    if (!token) return;
    fetch("/api/admin/requests?limit=10", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((d: { requests?: typeof requests }) => setRequests(d.requests ?? []))
      .catch(() => {});
  }, [token]);

  const modelShort = status.model?.split("/").pop() ?? "Unknown";

  return (
    <div className="fade-in max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "#ccff00" }}>Inference Studio</h1>
          <p className="text-xs mt-0.5" style={{ color: "#555" }}>Your local AI inference network</p>
        </div>
        <div className="flex items-center gap-2 text-xs" style={{ color: "#00e676" }}>
          <span className="w-2 h-2 rounded-full" style={{ background: "#00e676", boxShadow: "0 0 6px #00e676" }} />
          {modelShort} running
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "Active model", value: modelShort },
          { label: "GPU utilization", value: status.gpu_util ? `${Math.round(Number(status.gpu_util) * 100)}%` : "—" },
          { label: "Requests today", value: requests.filter(r => r.created_at.startsWith(new Date().toISOString().slice(0,10))).length },
        ].map(s => (
          <div key={s.label} className="p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
            <div className="text-xs mb-1" style={{ color: "#555" }}>{s.label}</div>
            <div className="font-mono text-sm" style={{ color: "#e8e8e8" }}>{String(s.value)}</div>
          </div>
        ))}
      </div>

      {/* Tunnel URL */}
      {status.tunnel_url && (
        <div className="mb-6 p-4" style={{ border: "1px solid rgba(204,255,0,0.2)", background: "rgba(204,255,0,0.03)" }}>
          <div className="text-xs mb-1 font-bold" style={{ color: "#ccff00" }}>Public tunnel active</div>
          <div className="flex items-center gap-3">
            <code className="text-xs font-mono flex-1 truncate" style={{ color: "#aaa" }}>{status.tunnel_url}</code>
            <button onClick={() => navigator.clipboard?.writeText(status.tunnel_url!)}
              className="text-xs px-2 py-1 shrink-0 transition-colors"
              style={{ border: "1px solid rgba(204,255,0,0.3)", color: "#ccff00" }}>
              copy
            </button>
          </div>
          <div className="text-xs mt-2" style={{ color: "#444" }}>
            Share this URL + an API key to allow remote access to your inference endpoint
          </div>
        </div>
      )}

      {/* Quick start */}
      <div className="mb-6 p-4" style={{ background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
        <div className="text-xs font-bold mb-3" style={{ color: "#ccff00" }}>Quick start</div>
        <pre className="text-xs overflow-x-auto" style={{ color: "#888", fontFamily: "var(--font-mono)" }}>{`curl http://localhost:3000/v1/chat/completions \\
  -H "Authorization: Bearer sk-studio-..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${status.model}",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'`}</pre>
      </div>

      {/* Links */}
      <div className="flex gap-3 mb-8">
        {[
          { href: "/chat",  label: "Open Chat →" },
          { href: "/voice", label: "Voice →" },
          { href: "/admin", label: "Manage keys →" },
        ].map(l => (
          <a key={l.href} href={l.href}
            className="px-4 py-2 text-sm transition-colors"
            style={{ border: "1px solid #222", color: "#666" }}
            onMouseOver={e => { e.currentTarget.style.borderColor = "rgba(204,255,0,0.3)"; e.currentTarget.style.color = "#ccff00"; }}
            onMouseOut={e => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.color = "#666"; }}>
            {l.label}
          </a>
        ))}
      </div>

      {/* Recent requests */}
      {requests.length > 0 && (
        <div>
          <div className="text-xs font-bold mb-3" style={{ color: "#ccff00" }}>Recent requests</div>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid #1e1e1e", color: "#444" }}>
                <th className="text-left py-1.5 pr-3">Time</th>
                <th className="text-left py-1.5 pr-3">Status</th>
                <th className="text-left py-1.5 pr-3">Model</th>
                <th className="text-right py-1.5">Tokens out</th>
              </tr>
            </thead>
            <tbody>
              {requests.slice(0, 8).map(r => (
                <tr key={r.id} style={{ borderBottom: "1px solid #111" }}>
                  <td className="py-1.5 pr-3" style={{ color: "#444" }}>
                    {new Date(r.created_at).toLocaleTimeString()}
                  </td>
                  <td className="py-1.5 pr-3" style={{ color: r.status === "completed" ? "#00e676" : r.status === "failed" ? "#ff4757" : "#888" }}>
                    {r.status}
                  </td>
                  <td className="py-1.5 pr-3 font-mono" style={{ color: "#666" }}>{r.model.split("/").pop()}</td>
                  <td className="py-1.5 text-right font-mono" style={{ color: "#888" }}>{r.tokens_out ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<"loading" | "setup" | "deploying" | "running">("loading");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/setup/status");
      const d = await r.json() as Status;
      setStatus(d);
      if (d.status === "running")                           setPhase("running");
      else if (d.status === "idle")                         setPhase("setup");
      else if (["pulling", "starting"].includes(d.status)) setPhase("deploying");
      else if (d.status === "error")                        setPhase("deploying");
    } catch { setPhase("setup"); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (phase !== "running") refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [refresh, phase]);

  return (
    <>
      <Navbar />
      <main className="px-6 py-12">
        {phase === "loading" && (
          <div className="text-center" style={{ color: "#444", marginTop: "20vh" }}>
            <div className="text-2xl mb-2" style={{ color: "#ccff00" }}>⋯</div>
            Connecting to Inference Studio…
          </div>
        )}
        {phase === "setup" && <SetupWizard onDeployed={() => setPhase("deploying")} />}
        {phase === "deploying" && status && (
          <DeployProgress status={status} onRunning={() => { setPhase("running"); refresh(); }} />
        )}
        {phase === "running" && status && <Dashboard status={status} />}
      </main>
    </>
  );
}
