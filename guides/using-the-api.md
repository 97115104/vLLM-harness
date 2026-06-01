# Using the Inference Studio API

After deploying a model (`bash deploy-locally.sh` → select model → wait for green status), you have a running OpenAI-compatible API. This guide walks through connecting clients to it.

---

## Step 1 — Get an API key

1. Open `http://localhost:3000/admin` in your browser
2. Log in (default: **admin / password**)
3. Go to the **Keys** tab
4. Enter a name (e.g. `my-app`) and click **+ Create key**
5. Copy the key immediately — it starts with `sk-studio-` and is only shown once

---

## Step 2 — Know your endpoint

| Where | Base URL |
|-------|----------|
| Same machine | `http://localhost:3000/v1` |
| Remote (tunnel URL from dashboard) | `https://xxx.trycloudflare.com/v1` |

---

## Step 3 — Make your first request

### Quick test (cURL)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "microsoft/Phi-4-mini-instruct",
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
    model="microsoft/Phi-4-mini-instruct",
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
    model="microsoft/Phi-4-mini-instruct",
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
  model:    "microsoft/Phi-4-mini-instruct",
  messages: [{ role: "user", content: "What is 17 × 6?" }],
});
console.log(response.choices[0].message.content);
```

---

## Finding your model name

The model name to use in requests is the full HuggingFace model ID, e.g.:

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
3. Share both — they can use them from any network, no VPN needed

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
    "model": "microsoft/Phi-4-mini-instruct",
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
    model="microsoft/Phi-4-mini-instruct",
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

**`401 invalid_api_key`** — double-check the key was copied correctly and is enabled in Admin → Keys.

**`503 engine_unavailable`** — no model is deployed. Go to `http://localhost:3000`, select a model, and wait for the green status indicator.

**Request times out** — the model may still be loading (large models take several minutes). Check the admin panel status or run `docker logs inference-studio-vllm | tail -20`.

**Streaming doesn't work** — make sure you're setting `"stream": true` and that your HTTP client supports SSE (server-sent events). The `/chat` interface always uses streaming.
