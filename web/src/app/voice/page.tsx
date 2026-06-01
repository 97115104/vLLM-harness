"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import Navbar from "@/components/navbar";

export default function VoicePage() {
  const [apiKey, setApiKey]       = useState(() => typeof window !== "undefined" ? localStorage.getItem("chat_api_key") ?? "" : "");
  const [model, setModel]         = useState("");
  const [prompt, setPrompt]       = useState("");
  const [output, setOutput]       = useState("");
  const [streaming, setStreaming] = useState(false);
  const [speaking, setSpeaking]   = useState(false);
  const [voices, setVoices]       = useState<SpeechSynthesisVoice[]>([]);
  const [voiceIdx, setVoiceIdx]   = useState(0);
  const [rate, setRate]           = useState(1.0);
  const [keyDraft, setKeyDraft]   = useState(apiKey);
  const [settingsOpen, setSettings] = useState(false);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const abortRef   = useRef<AbortController | null>(null);
  const animRef    = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const srcRef     = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    fetch("/api/setup/status")
      .then(r => r.json())
      .then((d: { status: string; model: string | null }) => {
        if (d.status === "running" && d.model) setModel(d.model);
      }).catch(() => {});
  }, []);

  useEffect(() => {
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // Waveform animation on canvas
  const startWaveform = useCallback((stream?: MediaStream) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    if (stream) {
      const ac = new AudioContext();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      const src = ac.createMediaStreamSource(stream);
      src.connect(analyser);
      analyserRef.current = analyser;
    }

    const draw = () => {
      animRef.current = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const bars = 32;
      const barW = canvas.width / bars;
      const analyser = analyserRef.current;

      if (analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        for (let i = 0; i < bars; i++) {
          const v = (data[Math.floor(i * data.length / bars)] / 255) * canvas.height * 0.85;
          const hue = 70 + (i / bars) * 20;
          ctx.fillStyle = `hsla(${hue}, 100%, 60%, 0.85)`;
          ctx.fillRect(i * barW + 1, canvas.height - v, barW - 2, v);
        }
      } else {
        // Idle breathing animation
        const t = Date.now() / 1000;
        for (let i = 0; i < bars; i++) {
          const v = (Math.sin(t * 1.2 + i * 0.4) * 0.5 + 0.5) * canvas.height * 0.12;
          ctx.fillStyle = "rgba(204,255,0,0.18)";
          ctx.fillRect(i * barW + 1, canvas.height / 2 - v, barW - 2, v * 2);
        }
      }
    };
    if (animRef.current) cancelAnimationFrame(animRef.current);
    draw();
  }, []);

  useEffect(() => {
    startWaveform();
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [startWaveform]);

  const generate = useCallback(async () => {
    if (!prompt.trim() || !apiKey || !model || streaming) return;
    setOutput(""); setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST", signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are a voice assistant. Respond naturally and conversationally, as if being read aloud. Avoid markdown, bullet points, and lists. Use natural speech patterns." },
            { role: "user", content: prompt },
          ],
          stream: true, max_tokens: 512,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const d = line.slice(6);
          if (d === "[DONE]") break;
          try {
            const c = JSON.parse(d) as { choices?: { delta?: { content?: string } }[] };
            const tok = c.choices?.[0]?.delta?.content ?? "";
            if (tok) { full += tok; setOutput(full); }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setOutput(`Error: ${e instanceof Error ? e.message : e}`);
    } finally {
      setStreaming(false);
    }
  }, [prompt, apiKey, model, streaming]);

  const speak = useCallback(() => {
    if (!output) return;
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(output);
    if (voices[voiceIdx]) utt.voice = voices[voiceIdx];
    utt.rate = rate;
    utt.onstart  = () => setSpeaking(true);
    utt.onend    = () => setSpeaking(false);
    utt.onerror  = () => setSpeaking(false);
    setSpeaking(true);
    speechSynthesis.speak(utt);
  }, [output, voices, voiceIdx, rate]);

  const stopSpeaking = () => { speechSynthesis.cancel(); setSpeaking(false); };

  const saveKey = () => { setApiKey(keyDraft); localStorage.setItem("chat_api_key", keyDraft); setSettings(false); };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <Navbar />

      {/* Topbar */}
      <div style={{ borderBottom: "1px solid #1a1a1a", padding: "0 16px", height: "40px", display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
        <span className="text-xs font-mono" style={{ color: "#555", flex: 1 }}>
          {model || "no model active"}
        </span>
        <button onClick={() => { setSettings(!settingsOpen); setKeyDraft(apiKey); }}
          className="text-xs px-2 py-0.5" style={{ border: "1px solid #222", color: "#555" }}>settings</button>
      </div>

      {settingsOpen && (
        <div style={{ borderBottom: "1px solid #1a1a1a", padding: "12px 16px", background: "#0f0f0f", flexShrink: 0 }}>
          <div className="flex gap-3 flex-wrap items-end">
            <div>
              <label className="block text-xs mb-1" style={{ color: "#555" }}>API Key</label>
              <input value={keyDraft} onChange={e => setKeyDraft(e.target.value)}
                placeholder="sk-studio-..." className="font-mono text-xs px-3 py-1.5 focus:outline-none w-64"
                style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }} />
            </div>
            {voices.length > 0 && (
              <div>
                <label className="block text-xs mb-1" style={{ color: "#555" }}>Voice</label>
                <select value={voiceIdx} onChange={e => setVoiceIdx(Number(e.target.value))}
                  className="text-xs px-2 py-1.5 focus:outline-none"
                  style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", color: "#e8e8e8" }}>
                  {voices.map((v, i) => <option key={i} value={i}>{v.name} ({v.lang})</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs mb-1" style={{ color: "#555" }}>Speed {rate}x</label>
              <input type="range" min="0.5" max="2" step="0.1" value={rate} onChange={e => setRate(Number(e.target.value))}
                style={{ accentColor: "#ccff00" }} />
            </div>
            <button onClick={saveKey} className="px-3 py-1.5 text-xs font-bold" style={{ background: "#ccff00", color: "#000" }}>Save</button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "24px 16px", gap: "24px", maxWidth: "640px", margin: "0 auto", width: "100%" }}>
        {/* Waveform */}
        <div className="flex flex-col items-center">
          <canvas ref={canvasRef} width={480} height={80}
            style={{ background: "#0a0a0a", border: "1px solid #1a1a1a", width: "100%", maxWidth: "480px", height: "80px" }} />
          {speaking && (
            <div className="text-xs mt-2 pulse-lime" style={{ color: "#ccff00" }}>Speaking…</div>
          )}
        </div>

        {/* Output */}
        {output && (
          <div style={{ padding: "16px", background: "#0f0f0f", border: "1px solid #1a1a1a" }}>
            <div className="text-xs mb-2 font-bold" style={{ color: "#ccff00" }}>Response</div>
            <p className="text-sm" style={{ color: "#ccc", lineHeight: "1.7" }}>{output}</p>
            <div className="flex gap-2 mt-4">
              {speaking ? (
                <button onClick={stopSpeaking}
                  className="px-3 py-1.5 text-xs" style={{ border: "1px solid rgba(255,71,87,0.4)", color: "#ff4757" }}>Stop</button>
              ) : (
                <button onClick={speak}
                  className="px-3 py-1.5 text-xs font-bold"
                  style={{ background: "#ccff00", color: "#000" }}>▶ Read aloud</button>
              )}
              <button onClick={() => navigator.clipboard?.writeText(output)}
                className="px-3 py-1.5 text-xs" style={{ border: "1px solid #222", color: "#666" }}>Copy</button>
            </div>
          </div>
        )}

        {/* Input */}
        <div>
          <label className="block text-xs mb-2" style={{ color: "#555" }}>Ask anything — the response will be read aloud</label>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); generate(); } }}
            placeholder={apiKey ? "What is the meaning of life?" : "Set an API key in Settings →"}
            rows={4}
            style={{
              width: "100%", resize: "none", background: "#0f0f0f", border: "1px solid #1e1e1e",
              color: "#e8e8e8", padding: "12px", fontSize: "14px", lineHeight: "1.6", outline: "none",
              fontFamily: "inherit",
            }} />

          <div className="flex gap-2 mt-3">
            {streaming ? (
              <button onClick={() => { abortRef.current?.abort(); setStreaming(false); }}
                className="px-4 py-2 text-sm" style={{ border: "1px solid rgba(255,71,87,0.4)", color: "#ff4757" }}>Stop</button>
            ) : (
              <button onClick={generate} disabled={!prompt.trim() || !apiKey || !model}
                className="px-5 py-2 text-sm font-bold transition-all"
                style={{
                  background: prompt.trim() && apiKey && model ? "#ccff00" : "#1a1a1a",
                  color: prompt.trim() && apiKey && model ? "#000" : "#444",
                  cursor: prompt.trim() && apiKey && model ? "pointer" : "not-allowed",
                }}>
                Generate + Read
              </button>
            )}
          </div>
        </div>

        {!apiKey && (
          <div className="text-xs text-center" style={{ color: "#333" }}>
            Generate an API key in <a href="/admin" style={{ color: "#555" }}>Admin</a> to get started
          </div>
        )}
      </div>
    </div>
  );
}
