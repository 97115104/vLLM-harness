# Using the Inference Studio API

After deploying a model (`bash deploy-locally.sh` > select model > wait for green status), you have a running OpenAI-compatible API.

---

## Step 1: Get an API key

1. Open `http://localhost:3000/admin` in your browser
2. Log in (default: **admin / password**)
3. Go to the **Keys** tab
4. Enter a name (e.g. `my-app`) and click **+ Create key**
5. Copy the key immediately (starts with `sk-studio-`, only shown once)

---

## Step 2: Know your endpoint

| Where | Base URL |
|-------|----------|
| Same machine | `http://localhost:3000/v1` |
| Remote (tunnel URL from dashboard) | `https://xxx.trycloudflare.com/v1` |

The base URL must end in `/v1`. Paths like `/chat` are the web UI, not the API.

---

## Connect any OpenAI-compatible client

Any app that supports a **custom OpenAI endpoint** can use Inference Studio. Examples: [Write Like Me](https://97115104.github.io/writelikeme/), Open WebUI, Continue, Cursor, n8n.

**Before you connect:** deploy a model on the dashboard and wait until status is **running**. Create an API key at `/admin` → **Keys**.

| Setting | Value |
|---------|--------|
| API provider | Custom endpoint (or “OpenAI-compatible”) |
| Base URL | `http://localhost:3000/v1` (same machine) or `https://your-tunnel.trycloudflare.com/v1` (remote) |
| API key | `sk-studio-...` from Admin → Keys |
| Model | `default` |

Use **`default`** as the model name to always target whatever model is currently deployed—you do not need the HuggingFace ID.

### How `default` works

External clients send `model: "default"`. vLLM does not understand that name on its own, so Inference Studio resolves it **before** forwarding the request:

1. Look up the model currently deployed in the dashboard (stored in SQLite).
2. Forward the request to vLLM with the deployed HuggingFace model ID.

`GET /v1/models` lists `default` plus the deployed HuggingFace ID when a model is running. Clients that preflight with `/models` (including [Write Like Me](https://97115104.github.io/writelikeme/)) will see `default` as a valid choice.

The built-in **`/chat`** page does not use `default`—it sends the full deployed model ID automatically. That is why `/chat` can work while a third-party app using `default` fails if the API is out of date or no model is deployed.

OpenAI-compatible fields are normalized on the way through. For example, `max_completion_tokens` (used by Write Like Me) is mapped to `max_tokens` before the request reaches vLLM.

### Example: Write Like Me

In **API Settings**:

- **API Provider:** Custom Endpoint
- **Base URL:** `http://localhost:3000/v1`
- **API Key:** your `sk-studio-...` key
- **Model:** `default`

If Write Like Me is open in a browser on a different machine than Inference Studio, `localhost` will not work. Use the tunnel URL from the dashboard instead (e.g. `https://abc-def.trycloudflare.com/v1`).

Write Like Me is served over **HTTPS** (GitHub Pages). Chrome allows `http://localhost` from HTTPS pages; Safari and Firefox may block it. If you hit mixed-content errors, use the tunnel URL (`https://…/v1`) instead of `http://localhost:3000/v1`.

Quick sanity check:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hi"}]}'
```

---

## Step 3: Make your first request

### Quick test (cURL)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 50
  }'
```

Expected response:
```json
{
  "choices": [{"message": {"content": "Hello! How can I assist you today?"}, ...}],
  "usage": {"prompt_tokens": 4, "completion_tokens": 9, "total_tokens": 13}
}
```

### Python (openai library)

Install once: `pip install openai`

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-studio-YOUR_KEY",
)

response = client.chat.completions.create(
    model="default",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user",   "content": "Explain what vLLM is in two sentences."},
    ],
)
print(response.choices[0].message.content)
```

### Python (streaming)

```python
stream = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Write a short poem about open source."}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
print()
```

### Node.js / TypeScript

```typescript
import OpenAI from "openai";  // npm install openai

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey:  "sk-studio-YOUR_KEY",
});

const response = await client.chat.completions.create({
  model:    "default",
  messages: [{ role: "user", content: "What is 17 × 6?" }],
});
console.log(response.choices[0].message.content);
```

---

## Finding your model name

The simplest option is **`default`**—it maps to the model currently deployed in Inference Studio.

You can also use the full HuggingFace model ID, e.g.:

| Model | ID to use in API |
|-------|-----------------|
| Mistral 7B | `mistralai/Mistral-7B-Instruct-v0.3` |
| Qwen 2.5 7B | `Qwen/Qwen2.5-7B-Instruct` |
| Phi-4 Mini | `microsoft/Phi-4-mini-instruct` |
| GPT-OSS 20B | `openai/gpt-oss-20b` |
| TinyLlama | `TinyLlama/TinyLlama-1.1B-Chat-v1.0` |

You can also look it up: `GET /v1/models` returns the currently running model.

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-studio-YOUR_KEY"
```

---

## Sharing access remotely

The deploy script starts a Cloudflare Quick Tunnel automatically. The public URL is shown:
- On the dashboard at `http://localhost:3000`
- In the terminal after `deploy-locally.sh` starts
- In Admin → Settings

To give someone else access:
1. Copy the tunnel URL (e.g. `https://abc-def.trycloudflare.com`)
2. Create an API key for them in Admin → Keys
3. Share both. They can connect from any network, no VPN needed

The recipient uses the tunnel URL as their `base_url`:
```python
client = OpenAI(
    base_url="https://abc-def.trycloudflare.com/v1",
    api_key="sk-studio-THEIR_KEY",
)
```

---

## Common integrations

### ChatGPT-style front-ends (Open WebUI, etc.)
Set the OpenAI API URL to `http://localhost:3000/v1` and use any `sk-studio-...` key.

### Continue.dev (VS Code AI assistant)
In `~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Local Phi-4",
    "provider": "openai",
    "model": "default",
    "apiBase": "http://localhost:3000/v1",
    "apiKey": "sk-studio-YOUR_KEY"
  }]
}
```

### Cursor
Settings → Models → Add a custom model, set the base URL to `http://localhost:3000/v1`.

### LangChain
```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="default",
    openai_api_base="http://localhost:3000/v1",
    openai_api_key="sk-studio-YOUR_KEY",
    streaming=True,
)
```

### n8n
Use the **OpenAI** node, set Base URL to your tunnel URL, and enter your `sk-studio-...` key.

---

## Managing usage

In the **Admin → Requests** tab you can see:
- Every inference request with timestamp, status, model, API key
- Token counts (in / out)
- Latency

To revoke a key: Admin → Keys → click **disable** or **del**.

---

## Troubleshooting

**`401 invalid_api_key`**: double-check the key was copied correctly and is enabled in Admin > Keys.

**`503 engine_unavailable`**: no model is deployed. Go to `http://localhost:3000`, select a model, and wait for the green status indicator.

**Request times out**: the model may still be loading (large models take several minutes). Check the admin panel status or run `docker logs inference-studio-vllm | tail -20`.

### External clients (Write Like Me, Open WebUI, etc.)

**`404 Endpoint not found` with model `default`**

This usually means vLLM received the literal name `default` instead of your deployed model ID. Common causes:

| Cause | Fix |
|-------|-----|
| No model deployed | Deploy a model on the dashboard and wait for **running** status |
| Wrong base URL | Use `http://localhost:3000/v1` — not `/chat` (that is the web UI) |
| API container out of date | Rebuild: `docker compose build api && docker compose up -d` |
| `localhost` from another device | Use the tunnel URL from the dashboard: `https://xxx.trycloudflare.com/v1` |
| Service just restarted | Wait for auto-redeploy to finish (pulling → starting → running) |

Preflight checks often call `GET /v1/models`, which can succeed even when `POST /v1/chat/completions` fails—because only the chat request needs a resolved model name.

**`/chat` works but Write Like Me does not**

The in-app chat page sends the deployed HuggingFace model ID. Write Like Me sends `default`. Both are supported, but `default` requires a running deployment and a current API build. Confirm with:

```bash
curl http://localhost:3000/v1/models -H "Authorization: Bearer sk-studio-YOUR_KEY"
```

You should see `default` in the list when a model is running.

**Streaming doesn't work**: make sure you're setting `"stream": true` and that your HTTP client supports SSE (server-sent events). The `/chat` interface always uses streaming.
