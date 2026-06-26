---
layout: default
title: Customization
nav_order: 4
---

# Customization

## Changing admin credentials

Edit `.env` before the first run, or via **Admin → Settings** after:

```bash
# .env
ADMIN_USERNAME=myname
ADMIN_PASSWORD=my-secure-password-here
JWT_SECRET=a-long-random-string-for-signing-jwt-tokens
```

After editing `.env`, restart the services:
```bash
docker compose down && docker compose up -d
```

## Changing ports

Edit `.env` and `docker-compose.yml`:

```yaml
# docker-compose.yml
services:
  web:
    ports:
      - "8080:3000"   # expose web on 8080 instead of 3000
  api:
    ports:
      - "8081:3001"   # expose API on 8081
```

Also update the `deploy-locally.sh` constants at the top:
```bash
WEB_PORT=8080
API_PORT=8081
```

## Adding models

Edit `api/src/routes/setup.ts` and add an entry to the `MODELS` array:

```typescript
{
  id: "your-org/your-model",
  name: "Your Model Name",
  description: "Brief description",
  params: "7B",
  vram_gb: 14,
  vram_int8_gb: 7,
  context_k: 32,
  tags: ["general", "chat"],
  no_auth: true,  // false if a HF token is required
},
```

Rebuild and restart:
```bash
docker compose build api && docker compose up -d api
```

## Persistent Cloudflare tunnel (named tunnel)

By default the tunnel URL changes on every restart. For a permanent URL:

1. Create a free Cloudflare account at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Add your domain (or use a free subdomain via Cloudflare Pages)
3. Create a named tunnel:
   ```bash
   cloudflared tunnel create inference-studio
   cloudflared tunnel route dns inference-studio your-subdomain.example.com
   ```
4. Add to your tunnel config (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: ~/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: your-subdomain.example.com
       service: http://localhost:3000
     - service: http_status:404
   ```
5. Run: `cloudflared tunnel run inference-studio`

## HuggingFace model cache location

By default, model weights are stored in a Docker volume (`hf_cache`). To store them on a specific host path (useful for NVMe drives):

```yaml
# docker-compose.yml
services:
  api:
    volumes:
      - /fast/nvme/hf_cache:/tmp/hf_cache  # change to your path
```

Remove the `hf_cache` volume declaration at the bottom.

## Running without Docker (advanced)

If you prefer to run natively:

```bash
# Terminal 1 - API
cd api
npm install
DATA_DIR=../data VLLM_URL=http://localhost:8000 ADMIN_PASSWORD=password npm run dev

# Terminal 2 - Web
cd web
npm install
API_URL=http://localhost:3001 npm run dev

# vLLM (requires NVIDIA GPU + nvidia-container-toolkit)
docker run -d \
  --name inference-studio-vllm \
  --runtime nvidia --gpus all \
  -p 8000:8000 --ipc host \
  vllm/vllm-openai:latest \
  --model mistralai/Mistral-7B-Instruct-v0.3 \
  --gpu-memory-utilization 0.90
```

## Custom vLLM startup flags

The API passes flags to vLLM via the `deployModel` function in `api/src/lib/docker.ts`. To add custom flags (e.g., `--quantization awq`, `--dtype bfloat16`), edit the `cmd` array in that function:

```typescript
const cmd = [
  "--model", model,
  "--host", "0.0.0.0",
  "--port", String(VLLM_PORT),
  "--max-model-len", "8192",    // larger context
  "--dtype", "bfloat16",        // BF16 instead of FP16
  "--quantization", "awq",      // AWQ quantization (needs AWQ model)
  "--trust-remote-code",
];
```

## Environment variables reference

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | `password` | Admin login password |
| `JWT_SECRET` | `inference-studio-change-me...` | JWT signing secret |
| `HF_TOKEN` | (empty) | Hugging Face token for gated models |
| `VLLM_URL` | `http://localhost:8000` | Address of the vLLM container |
| `DATA_DIR` | `./data` | SQLite database location |
| `HF_CACHE` | `/tmp/hf_cache` | HuggingFace model cache inside the API container |
| `GPU_TYPE` | `cpu` (or `nvidia`) | Set by `deploy-locally.sh`: `nvidia` for CUDA GPUs, `cpu` for Apple Silicon / no GPU |
| `VLLM_IMAGE` | (auto) | Override Docker image (`vllm/vllm-openai:latest` or `vllm/vllm-openai-cpu:latest-*`) |
| `DOCKER_NETWORK` | `inference-studio_default` | Docker network to attach vLLM to |
