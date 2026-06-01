# Inference Studio

**Run any open-source LLM locally — one command, polished web UI, instant remote API.**

```bash
git clone https://github.com/your-org/vLLM-harness
cd vLLM-harness
bash deploy-locally.sh
```

A browser window opens. Pick a model. Your own inference endpoint is live in minutes — accessible from any device via a free Cloudflare tunnel, no account required.

---

## Features

- **Automatic setup** — installs Docker, NVIDIA Container Toolkit, and cloudflared on Debian/Ubuntu, Arch, Fedora, or macOS
- **Model picker** — top 5 models (Mistral 7B, Qwen 2.5, GPT-OSS 20B, Phi-4 Mini, TinyLlama) + expandable list
- **Self-healing OOM** — if vLLM runs out of GPU memory, the system automatically retries with lower `--gpu-memory-utilization`
- **OpenAI-compatible API** — works with any OpenAI SDK client
- **API key management** — create, share, and revoke keys from the admin panel
- **Cloudflare Quick Tunnel** — share your endpoint with anyone, no port forwarding needed
- **Chat interface** — streaming chat with markdown rendering
- **Voice interface** — generate and read aloud with browser TTS

## Supported platforms

| OS | GPU |
|----|-----|
| Ubuntu / Debian | NVIDIA CUDA |
| Arch Linux | NVIDIA CUDA |
| Fedora / RHEL | NVIDIA CUDA |
| macOS (Apple Silicon) | Metal (experimental) |
| Any | CPU fallback |

## Default credentials

- Admin: **admin** / **password**
- Change immediately at `/admin` → Settings

## Documentation

Full docs: [docs/](docs/) — hosted via GitHub Pages when you enable it in repo Settings → Pages → `/docs` folder.

- [Features](docs/features.md)
- [API Reference](docs/api-reference.md)
- [Customization](docs/customization.md)
- [Setup & Troubleshooting](guides/setup-and-troubleshooting.md)

## Architecture

```
deploy-locally.sh → docker compose up
  ├── inference-studio-web    (Next.js, :3000)
  │     ├── /           Dashboard + model picker
  │     ├── /chat        Streaming chat
  │     ├── /voice       Voice interface
  │     └── /admin       API key management
  └── inference-studio-api    (Hono + SQLite, :3001)
        ├── /v1/*         OpenAI-compatible inference proxy
        ├── /admin/*      Admin auth + key management
        └── /setup/*      vLLM lifecycle management

  inference-studio-vllm       (on-demand, :8000)
    └── vllm/vllm-openai      LLM engine

  cloudflared → https://xxx.trycloudflare.com → :3000
```

## License

MIT
