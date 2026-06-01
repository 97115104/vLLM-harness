"use client";
import { useEffect, useState } from "react";
import { registerToastListener, unregisterToastListener, type ToastKind } from "@/lib/toast";

interface ToastItem { id: number; msg: string; kind: ToastKind; }
let _seq = 0;

export default function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    registerToastListener((msg, kind) => {
      const id = ++_seq;
      setToasts(p => [...p, { id, msg, kind }]);
      setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 2800);
    });
    return () => unregisterToastListener();
  }, []);

  if (!toasts.length) return null;

  return (
    <div style={{
      position: "fixed", bottom: "24px", right: "24px",
      display: "flex", flexDirection: "column", gap: "8px",
      zIndex: 9999, pointerEvents: "none",
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          padding: "10px 16px",
          background: "#111",
          border: `1px solid ${t.kind === "ok" ? "rgba(0,230,118,0.4)" : t.kind === "err" ? "rgba(255,71,87,0.4)" : "rgba(204,255,0,0.3)"}`,
          color: t.kind === "ok" ? "#00e676" : t.kind === "err" ? "#ff4757" : "#ccff00",
          fontSize: "12px",
          fontFamily: "inherit",
          animation: "toast-in 0.2s ease-out",
          maxWidth: "280px",
          boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
        }}>
          {t.kind === "ok" ? "✓ " : t.kind === "err" ? "✗ " : ""}
          {t.msg}
        </div>
      ))}
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
