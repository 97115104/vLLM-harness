# Inference Studio: Setup & Troubleshooting

## Quick start

```bash
git clone https://github.com/your-org/vLLM-harness
cd vLLM-harness
bash deploy-locally.sh
```

The script handles everything: installing Docker, NVIDIA drivers, pulling the vLLM image, starting the web UI, and creating a Cloudflare tunnel for external access.

---

## What the script does

| Step | What happens |
|------|-------------|
| OS detection | Identifies macOS, Debian/Ubuntu, Arch, or Fedora |
| Dependency install | Installs Docker, nvidia-container-toolkit (NVIDIA), cloudflared |
| GPU detection | Finds your NVIDIA GPU and measures available VRAM |
| Docker build | Builds the API and web containers (~2–5 min first run) |
| Service start | Starts API (port 3001) and web UI (port 3000) |
| Tunnel | Opens a free Cloudflare Quick Tunnel on trycloudflare.com |
| Browser | Opens http://localhost:3000 automatically |

---

## System requirements

### Minimum (CPU mode)
- 16 GB RAM
- 10 GB free disk space (for Docker images)
- Docker 24+
- macOS 12+, Ubuntu 20.04+, Arch, or Fedora 36+

### Recommended (GPU mode)
- NVIDIA GPU with 8+ GB VRAM (16+ GB for 7B models at full precision)
- Ubuntu 22.04 / Debian 12 / Arch / Fedora 38+
- NVIDIA driver 525+ (`nvidia-smi` should work before running the script)

### macOS (Apple Silicon)
- macOS 13+ with M1/M2/M3
- 16+ GB unified memory
- Docker Desktop installed and running

---

## First-run model selection

After the script starts the services, your browser opens to `http://localhost:3000`. If no model is deployed yet, you'll see the model picker:

1. **Choose a model** from the top 5, or click "View more" for the full list
2. Models marked **HF token** require accepting terms on huggingface.co first
3. Click **Deploy**. The system pulls the Docker image and starts vLLM
4. Wait for the green "running" indicator (large models may take 5–15 min to download)

**VRAM guidance:**
| Model | VRAM needed |
|-------|------------|
| TinyLlama 1.1B | 2 GB |
| Phi-4 Mini 3.8B | 8 GB |
| Mistral 7B / Qwen 7B | 14 GB (fp16) or 7 GB (int8) |
| GPT-OSS 20B | 40 GB |

---

## Generating API keys

1. Open `http://localhost:3000/admin` (or click **Admin** in the navbar)
2. Log in with **admin / password** (change this immediately!)
3. Go to the **Keys** tab
4. Enter a name, click **+ Create key**
5. Copy the key (shown once only)

API keys look like: `sk-studio-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

---

## Using the API

Inference Studio exposes an **OpenAI-compatible API**. Any client that works with OpenAI will work here. Just change the base URL and API key.

### cURL example

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistralai/Mistral-7B-Instruct-v0.3",
    "messages": [{"role": "user", "content": "Explain quantum entanglement simply."}],
    "stream": true
  }'
```

### Python (openai library)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-studio-YOUR_KEY",
)

response = client.chat.completions.create(
    model="mistralai/Mistral-7B-Instruct-v0.3",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### Remote access via Cloudflare tunnel

Replace `http://localhost:3000` with the tunnel URL shown on your dashboard:

```bash
curl https://xxx-yyy-zzz.trycloudflare.com/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  ...
```

The tunnel URL changes every time you restart the script. Share it with your API key for remote access. No port forwarding needed.

---

## Troubleshooting

### "Docker is not running"

```bash
# Linux - start Docker
sudo systemctl start docker

# macOS - open Docker Desktop from Applications, wait for it to start
open -a Docker
```

### "Cannot access Docker socket"

```bash
sudo chmod 666 /var/run/docker.sock
# Or add your user to the docker group (requires re-login):
sudo usermod -aG docker $USER
newgrp docker
```

### NVIDIA GPU not detected in Docker

1. Verify the driver works: `nvidia-smi`
2. Reinstall the toolkit:
   ```bash
   sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```
3. Test: `docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi`

### CUDA out of memory (OOM)

The system automatically retries with lower `--gpu-memory-utilization` (from 0.90 down to 0.50 in 0.10 steps). You'll see this in the logs:

```
OOM detected - retrying at gpu_memory_utilization=0.80
```

If it still fails at 0.50, the model is too large for your GPU. Try a smaller model (Phi-4 Mini or TinyLlama).

**Manual override**: if you want to force a specific utilization, stop the current deployment and re-deploy via the admin panel.

### vLLM container starts but model never loads

Check container logs:

```bash
docker logs inference-studio-vllm --tail 50
```

Common causes:
- Model requires a Hugging Face token → enter it in the deploy dialog
- Insufficient disk space for model weights → free up space or change the HF cache location
- Model not available without HF token (gated model like Llama) → accept terms at huggingface.co and provide your token

### Web UI shows "no model active" even after deploying

The API container manages the vLLM container. If it shows idle:
1. Check API logs: `docker compose logs api`
2. Check if the vLLM container is running: `docker ps | grep vllm`
3. Verify the vLLM health endpoint: `curl http://localhost:8000/health`

### Cloudflare tunnel fails to start

The tunnel is optional. If it doesn't start:
- Your instance still works locally at `http://localhost:3000`
- To manually start a tunnel: `cloudflared tunnel --url http://localhost:3000`
- The tunnel URL is temporary. It changes every restart. For a permanent URL, [create a free Cloudflare account](https://dash.cloudflare.com/sign-up) and set up a named tunnel.

### Admin login doesn't work

Default credentials: **admin** / **password**

If you've forgotten a changed password, reset via the command line:

```bash
# Stop services
docker compose stop

# Delete the database to reset all settings (⚠ this deletes API keys too)
rm data/studio.db

# Restart
docker compose up -d
```

Or set a new password via the API directly:

```bash
# First get a token with the current password
TOKEN=$(curl -s -X POST http://localhost:3001/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"OLD_PASSWORD"}' | grep -oP '"token":"\K[^"]+')

# Then change it
curl -X POST http://localhost:3001/admin/password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"current":"OLD_PASSWORD","new":"NEW_PASSWORD"}'
```

### Services stop when I close the terminal

Run in a persistent session:

```bash
# Using screen
screen -S inference-studio
bash deploy-locally.sh
# Detach: Ctrl+A then D
# Reattach: screen -r inference-studio

# Using tmux
tmux new -s inference-studio
bash deploy-locally.sh
# Detach: Ctrl+B then D
# Reattach: tmux attach -t inference-studio

# Using nohup
nohup bash deploy-locally.sh &>/var/log/inference-studio.log &
```

### Port conflicts

If ports 3000 or 3001 are already in use:

```bash
# Find what's using the port
sudo lsof -i :3000

# Edit .env to change the ports (then edit docker-compose.yml to match)
WEB_PORT=8080
```

---

## Updating

```bash
git pull
docker compose build --pull
docker compose up -d
```

---

## Uninstalling

```bash
# Stop and remove containers
docker compose down

# Remove Docker volumes (HuggingFace model cache, this is large!)
docker volume rm inference-studio_hf_cache

# Remove data directory (API keys, request history)
rm -rf data/
```

The vLLM Docker images are large (~8 GB). Remove them:

```bash
docker rmi vllm/vllm-openai:latest
docker rmi inference-studio-api
docker rmi inference-studio-web
```
