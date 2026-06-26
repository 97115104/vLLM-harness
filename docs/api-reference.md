---
layout: default
title: API Reference
nav_order: 3
---

# API Reference

Inference Studio exposes an OpenAI-compatible API. Any client that works with the OpenAI SDK will work here. Just change the `base_url` and `api_key`.

## Base URL

Use the **`/v1`** path for all API clients (OpenAI SDK, Write Like Me, Continue, etc.):

| Where | Base URL |
|-------|----------|
| Local | `http://localhost:3000/v1` |
| Remote (tunnel) | `https://xxx-yyy-zzz.trycloudflare.com/v1` |

The root URL (`http://localhost:3000`) serves the web UI. Paths like `/chat` are pages, not the API.

See [Using the API](../guides/using-the-api.md) for connecting third-party clients with model `default`.

## Authentication

All inference requests (`/v1/*`) require an API key:

```
Authorization: Bearer sk-studio-YOUR_KEY_HERE
```

Generate keys at `/admin` → **Keys** tab.

---

## Chat Completions

### `POST /v1/chat/completions`

Standard OpenAI chat completions format.

**Request body:**
```json
{
  "model": "default",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user",   "content": "What is 2+2?"}
  ],
  "stream": true,
  "max_tokens": 1024,
  "temperature": 0.7
}
```

Use **`default`** to target the model currently deployed in the dashboard. Inference Studio resolves it to the deployed HuggingFace model ID before forwarding to vLLM. You can also pass the full HuggingFace model ID directly.

`max_completion_tokens` is accepted and mapped to `max_tokens` for clients that send the newer OpenAI field name.

**Alternate request (explicit model ID):**
```json
{
  "model": "mistralai/Mistral-7B-Instruct-v0.3",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user",   "content": "What is 2+2?"}
  ],
  "stream": true,
  "max_tokens": 1024,
  "temperature": 0.7
}
```

**Non-streaming response:**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "mistralai/Mistral-7B-Instruct-v0.3",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "4"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 12, "completion_tokens": 1, "total_tokens": 13}
}
```

**Streaming response (SSE):**
```
data: {"choices":[{"delta":{"content":"4"},"index":0}]}

data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}

data: [DONE]
```

### `GET /v1/models`

Lists available models when a deployment is **running**. Always includes `default` (alias for the active model) plus the deployed HuggingFace ID.

```json
{
  "object": "list",
  "data": [
    {
      "id": "default",
      "object": "model",
      "created": 1234567890,
      "owned_by": "vllm"
    },
    {
      "id": "mistralai/Mistral-7B-Instruct-v0.3",
      "object": "model",
      "created": 1234567890,
      "owned_by": "vllm"
    }
  ]
}
```

Returns an empty list if no model is deployed.

---

## Code examples

### Python (openai library)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-studio-YOUR_KEY",
)

# Non-streaming
response = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Count to 10"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### JavaScript / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "sk-studio-YOUR_KEY",
  dangerouslyAllowBrowser: true,  // only for browser-side usage
});

const stream = client.beta.chat.completions.stream({
  model: "default",
  messages: [{ role: "user", content: "Hello!" }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### cURL

```bash
# Non-streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="default",
    openai_api_base="http://localhost:3000/v1",
    openai_api_key="sk-studio-YOUR_KEY",
    streaming=True,
)

result = llm.invoke("What is the capital of France?")
print(result.content)
```

---

## Admin API (JWT)

Admin endpoints use a short-lived JWT. Get one with:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password"}' \
  | jq -r .token)
```

### Create an API key

```bash
curl -X POST http://localhost:3000/api/admin/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","owner_email":"me@example.com"}'
```

Response:
```json
{"key":"sk-studio-...","id":"...","prefix":"sk-studio-XXXX"}
```

### List keys

```bash
curl http://localhost:3000/api/admin/keys \
  -H "Authorization: Bearer $TOKEN"
```

### Disable a key

```bash
curl -X PATCH http://localhost:3000/api/admin/keys/KEY_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active": false}'
```

### Deploy a model

```bash
curl -X POST http://localhost:3000/api/setup/deploy \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"mistralai/Mistral-7B-Instruct-v0.3"}'
```

### Get deployment status

```bash
curl http://localhost:3000/api/setup/status
```

Response:
```json
{
  "status": "running",
  "model": "mistralai/Mistral-7B-Instruct-v0.3",
  "error": null,
  "progress": null,
  "gpu_util": "0.9",
  "tunnel_url": "https://xxx-yyy-zzz.trycloudflare.com"
}
```

Status values: `idle`, `pulling`, `starting`, `running`, `error`.
