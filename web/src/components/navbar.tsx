"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function Navbar() {
  const path = usePathname();
  const [status, setStatus] = useState<"idle" | "running" | "loading">("loading");

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch("/api/setup/status");
        const d = await r.json() as { status: string };
        if (alive) setStatus(d.status === "running" ? "running" : "idle");
      } catch { if (alive) setStatus("idle"); }
    };
    check();
    const t = setInterval(check, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const nav = [
    { href: "/",     label: "Dashboard" },
    { href: "/chat", label: "Chat" },
  ];

  return (
    <header style={{ background: "#0f0f0f", borderBottom: "1px solid #1e1e1e" }}
      className="sticky top-0 z-50 flex items-center gap-6 px-6 h-12">
      <Link href="/" className="font-bold text-sm tracking-wider" style={{ color: "#ccff00" }}>
        Inference Studio
      </Link>

      <nav className="flex gap-1 flex-1">
        {nav.map(n => (
          <Link key={n.href} href={n.href}
            style={{ color: path === n.href ? "#ccff00" : "#666" }}
            className="px-3 py-1 text-sm hover:text-white transition-colors">
            {n.label}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-xs" style={{ color: "#555" }}>
          <span className="w-1.5 h-1.5 rounded-full inline-block"
            style={{
              background: status === "running" ? "#00e676" : status === "loading" ? "#ccff00" : "#444",
              ...(status === "running" ? { boxShadow: "0 0 6px #00e676" } : {}),
            }} />
          {status === "running" ? "model running" : status === "loading" ? "checking..." : "no model"}
        </span>
        <Link href="/admin"
          style={{ color: path.startsWith("/admin") ? "#ccff00" : "#555" }}
          className="text-xs hover:text-white transition-colors px-2 py-1 border border-transparent hover:border-[#333]">
          Admin
        </Link>
      </div>
    </header>
  );
}
