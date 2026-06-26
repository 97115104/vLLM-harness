---
layout: default
title: Inference Studio
nav_order: 1
---

# Inference Studio

**Run any open-source LLM on your own hardware. One command, polished web interface, instant remote access.**

```bash
git clone https://github.com/your-org/vLLM-harness
cd vLLM-harness
bash deploy-locally.sh
```

The script installs every dependency, detects your GPU, pulls the model, and opens a browser window.

---

## What you get

- **Web-based model picker**: choose from Mistral 7B, Qwen 2.5, GPT-OSS 20B, Phi-4 Mini, TinyLlama, and more
- **Chat interface**: polished dark UI, streaming responses, conversation history
- **Voice interface**: generate responses and read them aloud with browser TTS
- **Admin dashboard**: create/manage API keys, view request logs, change passwords
- **OpenAI-compatible API**: works with any client that supports the OpenAI SDK; use model `default` for the active deployment
- **Cloudflare Quick Tunnel**: instant remote access, no account required, no port forwarding
- **Auto-recovery on restart**: if a model was deployed before a service restart, the API automatically redeploys it instead of showing an error
- **Self-healing OOM**: automatically adjusts GPU memory utilization if the model doesn't fit

---

## Navigation

- [Features](features.md) - full feature list and capability overview
- [Using the API](completions.md) - chat completions, streaming, SDK examples, integrations
- [API Reference](api-reference.md) - full endpoint reference and admin API
- [Customization](customization.md) - changing models, ports, credentials, and more
- [Setup Guide](../guides/setup-and-troubleshooting.md) - installation, troubleshooting
- [API Usage Guide](../guides/using-the-api.md) - connecting clients, remote access, common integrations

---

## Supported platforms

| Platform | GPU | Status |
|----------|-----|--------|
| Ubuntu 20.04+ / Debian 11+ | NVIDIA (CUDA) | ✅ Full support |
| Arch Linux | NVIDIA (CUDA) | ✅ Full support |
| Fedora 36+ / RHEL 9+ | NVIDIA (CUDA) | ✅ Full support |
| macOS 13+ (Apple Silicon) | CPU (Docker) | ✅ Works — Docker cannot use Metal; uses `vllm-openai-cpu` image |
| Any (CPU fallback) | None | ✅ Slow but works |

---

## Quick architecture overview

```
deploy-locally.sh
  └── docker compose up
        ├── inference-studio-web   (Next.js, port 3000)
        │     ├── /             Dashboard + model picker
        │     ├── /chat         Streaming chat UI
        │     ├── /voice        Voice interface
        │     └── /admin        API key management
        │
        └── inference-studio-api   (Hono, port 3001)
              ├── SQLite DB      (API keys, requests, settings)
              ├── Docker socket  (manages vLLM container)
              ├── Auto-recovery  (redeploys last model on restart)
              └── vLLM proxy     (OpenAI-compatible /v1/*)

      inference-studio-vllm      (started on demand, port 8000)
        └── vllm/vllm-openai     (the actual LLM engine)

  cloudflared tunnel → https://xxx.trycloudflare.com → port 3000
```
