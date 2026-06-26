"use client";
import { useState, useRef, useEffect, useCallback } from "react";

type Role = "user" | "assistant" | "system";
type Message = { role: Role; content: string; id: string };

let _id = 0;
const uid = () => `m${++_id}`;

function ThinkingIndicator() {
  return (
    <span className="flex items-center gap-2" style={{ color: "#666" }}>
      <span className="text-sm">Thinking</span>
      <span className="thinking-dots flex items-center gap-1">
        <span /><span /><span />
      </span>
    </span>
  );
}

function Bubble({ msg, loading, streaming }: { msg: Message; loading?: boolean; streaming?: boolean }) {
  const isUser = msg.role === "user";
  const isError = !isUser && msg.content.startsWith("[error]");
  return (
    <div className={`flex gap-3 fade-in ${isUser ? "flex-row-reverse" : ""}`}>
      <div className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5"
        style={{ background: isUser ? "rgba(204,255,0,0.15)" : loading ? "rgba(204,255,0,0.08)" : "#1a1a1a", color: isUser ? "#ccff00" : loading ? "#ccff00" : "#666" }}>
        {isUser ? "U" : "AI"}
      </div>
      <div className={`max-w-[80%] px-4 py-3 text-sm leading-relaxed prose ${isUser ? "text-right" : ""}`}
        style={{
          background: isUser ? "rgba(204,255,0,0.06)" : loading ? "rgba(204,255,0,0.03)" : "#0f0f0f",
          border: `1px solid ${isUser ? "rgba(204,255,0,0.15)" : loading ? "rgba(204,255,0,0.2)" : "#1a1a1a"}`,
          borderRadius: "2px",
          color: isError ? "#ff4757" : "#e8e8e8",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minHeight: loading ? "2.5rem" : undefined,
        }}>
        {loading ? (
          <ThinkingIndicator />
        ) : (
          <>
            {msg.content}
            {streaming && (
              <span className="stream-cursor inline-block ml-0.5" style={{ color: "#ccff00" }}>▋</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages]     = useState<Message[]>([]);
  const [input, setInput]           = useState("");
  const [apiKey, setApiKey]         = useState(() => typeof window !== "undefined" ? localStorage.getItem("chat_api_key") ?? "" : "");
  const [model, setModel]           = useState("");
  const [maxTokens, setMaxTokens]   = useState(512);
  const [streaming, setStreaming]   = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [settingsOpen, setSettings] = useState(false);
  const [keyDraft, setKeyDraft]     = useState(apiKey);
  const [system, setSystem]         = useState("You are a helpful assistant.");
  const [status, setStatus]         = useState<"unknown" | "ok" | "err">("unknown");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef  = useRef<AbortController | null>(null);

  // Auto-detect active model and context limit
  useEffect(() => {
    fetch("/api/setup/status")
      .then(r => r.json())
      .then((d: { status: string; model: string | null; max_model_len?: string | null }) => {
        if (d.status === "running" && d.model) setModel(d.model);
        const len = Number(d.max_model_len) || 1024;
        setMaxTokens(Math.max(64, Math.min(512, len - 256)));
      }).catch(() => {});
  }, []);

  // Check API key connectivity
  useEffect(() => {
    if (!apiKey) { setStatus("unknown"); return; }
    fetch("/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(r => setStatus(r.ok ? "ok" : "err"))
      .catch(() => setStatus("err"));
  }, [apiKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !apiKey || !model) return;

    setInput("");
    const userMsg: Message = { role: "user", content: text, id: uid() };
    const assistantMsg: Message = { role: "assistant", content: "", id: uid() };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    setStreamingId(assistantMsg.id);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const history: Message[] = [...messages, userMsg];
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            ...history.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })),
          ],
          stream: true,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: { message: string } };
        throw new Error(err.error?.message ?? `HTTP ${res.status}`);
      }

      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;
          try {
            const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              setMessages(prev => prev.map(m =>
                m.id === assistantMsg.id ? { ...m, content: m.content + delta } : m
              ));
            }
          } catch { /* malformed chunk */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, content: `[error] ${e instanceof Error ? e.message : e}` } : m
        ));
      }
    } finally {
      setStreaming(false);
      setStreamingId(null);
      abortRef.current = null;
    }
  }, [input, streaming, apiKey, model, messages, system, maxTokens]);

  const stop = () => { abortRef.current?.abort(); setStreaming(false); setStreamingId(null); };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const saveKey = () => {
    setApiKey(keyDraft);
    localStorage.setItem("chat_api_key", keyDraft);
    setSettings(false);
  };

  const statusColor = status === "ok" ? "#00e676" : status === "err" ? "#ff4757" : "#444";
  const statusLabel = status === "ok" ? "connected" : status === "err" ? "invalid key" : "not set";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      {/* Topbar */}
      <div style={{ borderBottom: "1px solid #1a1a1a", padding: "0 16px", height: "40px", display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
        <a href="/" style={{ color: "#ccff00", fontSize: "13px", fontWeight: 700, letterSpacing: "0.05em", textDecoration: "none", whiteSpace: "nowrap" }}>
          Inference Studio
        </a>
        <span style={{ color: "#2a2a2a" }}>|</span>
        <span className="text-xs font-mono" style={{ color: "#555", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {model || "no model active"}
        </span>
        <span className="flex items-center gap-1.5 text-xs" style={{ color: statusColor }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
          {statusLabel}
        </span>
        <button onClick={() => { setSettings(!settingsOpen); setKeyDraft(apiKey); }}
          className="text-xs px-2 py-0.5 transition-colors"
          style={{ border: "1px solid #222", color: "#555" }}>
          settings
        </button>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])}
            className="text-xs transition-colors" style={{ color: "#444" }}>
            clear
          </button>
        )}
      </div>

      {/* Settings panel */}
      {settingsOpen && (
        <div style={{ borderBottom: "1px solid #1a1a1a", padding: "12px 16px", background: "#0f0f0f", flexShrink: 0 }}>
          <div className="flex gap-3 flex-wrap items-end">
            <div>
              <label className="block text-xs mb-1" style={{ color: "#555" }}>API Key</label>
              <input value={keyDraft} onChange={e => setKeyDraft(e.target.value)}
                placeholder="sk-studio-..."
                className="font-mono text-xs px-3 py-1.5 focus:outline-none w-64"
                style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: "#555" }}>System prompt</label>
              <input value={system} onChange={e => setSystem(e.target.value)}
                className="text-xs px-3 py-1.5 focus:outline-none w-80"
                style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
            </div>
            <button onClick={saveKey}
              className="px-3 py-1.5 text-xs font-bold"
              style={{ background: "#ccff00", color: "#000" }}>
              Save
            </button>
          </div>
          {!apiKey && (
            <p className="text-xs mt-2" style={{ color: "#555" }}>
              Generate an API key in <a href="/admin" style={{ color: "#ccff00" }}>Admin → Keys</a>
            </p>
          )}
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 16px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {messages.length === 0 ? (
          <div className="text-center" style={{ marginTop: "15vh", color: "#333" }}>
            <div className="text-4xl mb-4" style={{ color: "#1a1a1a" }}>◈</div>
            <div className="text-sm mb-1" style={{ color: "#444" }}>Start a conversation</div>
            {!apiKey && (
              <div className="text-xs mt-3" style={{ color: "#333" }}>
                Set an API key in Settings to get started
              </div>
            )}
          </div>
        ) : (
          messages.map(m => (
            <Bubble
              key={m.id}
              msg={m}
              loading={streamingId === m.id && m.role === "assistant" && !m.content}
              streaming={streamingId === m.id && m.role === "assistant" && !!m.content}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ borderTop: "1px solid #1a1a1a", padding: "12px 16px", flexShrink: 0, background: "#080808" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={apiKey ? "Message… (Enter to send, Shift+Enter for newline)" : "Set an API key in Settings →"}
            disabled={!apiKey || streaming}
            rows={1}
            style={{
              flex: 1, resize: "none", background: "#0f0f0f", border: "1px solid #1e1e1e",
              color: "#e8e8e8", padding: "10px 14px", fontSize: "14px", lineHeight: "1.5",
              outline: "none", maxHeight: "160px", overflow: "auto",
              fontFamily: "inherit",
            }}
            onInput={e => {
              const t = e.target as HTMLTextAreaElement;
              t.style.height = "auto";
              t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
            }}
          />
          {streaming ? (
            <button onClick={stop}
              className="px-3 py-2 text-xs shrink-0"
              style={{ border: "1px solid rgba(255,71,87,0.4)", color: "#ff4757" }}>
              Stop
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim() || !apiKey || !model}
              className="px-4 py-2 text-sm font-bold shrink-0 transition-all"
              style={{
                background: input.trim() && apiKey && model ? "#ccff00" : "#1a1a1a",
                color: input.trim() && apiKey && model ? "#000" : "#444",
                cursor: input.trim() && apiKey && model ? "pointer" : "not-allowed",
              }}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
