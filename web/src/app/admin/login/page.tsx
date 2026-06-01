"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AdminLogin() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const router = useRouter();

  const login = async () => {
    setError(""); setLoading(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, ...(needsTotp ? { totpCode } : {}) }),
      });
      const d = await res.json() as { token?: string; error?: string; needsTotp?: boolean };

      if (d.needsTotp) {
        setNeedsTotp(true);
        setLoading(false);
        return;
      }
      if (d.token) {
        localStorage.setItem("admin_token", d.token);
        router.replace("/admin");
      } else {
        setError(d.error ?? "Login failed");
      }
    } catch { setError("Network error"); }
    finally { setLoading(false); }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") login();
  };

  return (
    <div style={{ minHeight: "100vh", background: "#080808", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "360px", padding: "40px", background: "#0f0f0f", border: "1px solid #1e1e1e" }}>
        <div className="mb-8">
          <h1 className="text-xl font-bold" style={{ color: "#ccff00" }}>Inference Studio</h1>
          <p className="text-xs mt-1" style={{ color: "#555" }}>
            {needsTotp ? "Enter your authenticator code" : "Admin login"}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 text-sm" style={{ background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", color: "#ff4757" }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-4">
          {!needsTotp ? (
            <>
              <div>
                <label className="block text-xs mb-1" style={{ color: "#555" }}>Username</label>
                <input value={username} onChange={e => setUsername(e.target.value)} onKeyDown={handleKey}
                  className="w-full px-3 py-2 text-sm focus:outline-none"
                  style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: "#555" }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={handleKey}
                  className="w-full px-3 py-2 text-sm focus:outline-none"
                  style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs mb-1" style={{ color: "#555" }}>Authenticator code</label>
              <input
                value={totpCode}
                onChange={e => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={handleKey}
                placeholder="000000"
                maxLength={6}
                inputMode="numeric"
                autoFocus
                className="w-full px-3 py-2 text-sm font-mono tracking-widest focus:outline-none"
                style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }}
              />
              <button onClick={() => { setNeedsTotp(false); setTotpCode(""); setError(""); }}
                className="text-xs mt-2" style={{ color: "#555" }}>
                ← Back
              </button>
            </div>
          )}

          <button onClick={login}
            disabled={loading || (!needsTotp && !password) || (needsTotp && totpCode.length !== 6)}
            className="w-full py-2 text-sm font-bold transition-all"
            style={{
              background: (!loading && ((!needsTotp && password) || (needsTotp && totpCode.length === 6))) ? "#ccff00" : "#1a1a1a",
              color: (!loading && ((!needsTotp && password) || (needsTotp && totpCode.length === 6))) ? "#000" : "#444",
              cursor: loading ? "not-allowed" : "pointer",
            }}>
            {loading ? "Signing in…" : needsTotp ? "Verify" : "Sign in"}
          </button>
        </div>

        {!needsTotp && (
          <p className="text-xs mt-6 text-center" style={{ color: "#333" }}>
            Default: admin / password
          </p>
        )}
      </div>
    </div>
  );
}
