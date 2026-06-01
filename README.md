# Inference Studio

**Run any open-source LLM on your own hardware — one command, polished web UI, instant remote API.**

```bash
git clone https://github.com/your-org/vLLM-harness
cd vLLM-harness
bash deploy-locally.sh
```

A browser window opens. Pick a model. Your own inference endpoint is live in minutes — accessible from anywhere via a free Cloudflare tunnel, no account required.

---

## Features

- **Zero-touch setup** — installs Docker, NVIDIA Container Toolkit, and cloudflared automatically on Debian/Ubuntu, Arch/CachyOS, Fedora, or macOS
- **Model picker** — choose from Mistral 7B, Qwen 2.5, GPT-OSS 20B, Phi-4 Mini, TinyLlama, and more — all requiring no HuggingFace token
- **Self-healing OOM** — if vLLM runs out of GPU memory, the system automatically retries with decreasing `--gpu-memory-utilization` (0.90 → 0.45)
- **OpenAI-compatible API** — works with any OpenAI SDK client
- **API key management** — create, share, and revoke keys from the admin panel
- **Cloudflare Quick Tunnel** — share your endpoint with anyone, no port forwarding, no account needed
- **Chat interface** — streaming chat with markdown rendering
- **Admin dashboard** — deploy models, manage keys, view request logs

## Supported platforms

| OS | GPU |
|----|-----|
| Ubuntu / Debian | NVIDIA CUDA |
| Arch / CachyOS | NVIDIA CUDA |
| Fedora / RHEL | NVIDIA CUDA |
| macOS (Apple Silicon) | Metal (experimental) |
| Any | CPU fallback |

## Default credentials

Admin: **admin** / **password** — change immediately at `/admin` → Settings.

## Documentation

- [Features](docs/features.md)
- [API Reference](docs/api-reference.md)
- [Customization](docs/customization.md)
- [Setup & Troubleshooting](guides/setup-and-troubleshooting.md)

Host the docs via GitHub Pages: repo Settings → Pages → Source: `/docs` folder.

## Architecture

```
deploy-locally.sh → docker compose up
  ├── inference-studio-web    (Next.js, :3000)
  │     ├── /           Dashboard + model picker
  │     ├── /chat        Streaming chat
  │     └── /admin       API key management
  └── inference-studio-api    (Hono + SQLite, :3001)
        ├── /v1/*         OpenAI-compatible inference proxy
        ├── /admin/*      Admin auth + key management
        └── /setup/*      vLLM lifecycle management

  inference-studio-vllm       (on-demand, host network, :8000)
    └── vllm/vllm-openai      LLM engine

  cloudflared → https://xxx.trycloudflare.com → :3000
```

---

## License

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Attestation

This project was built in collaboration with Claude Sonnet 4.6 (Anthropic).

[![Attested by Claude Sonnet 4.6](https://attest.97115104.com/badge/cy1a0o3x)](https://attest.97115104.com/s/cy1a0o3x)

Verify: [attest.97115104.com/s/cy1a0o3x](https://attest.97115104.com/s/cy1a0o3x)
