---
layout: default
title: Using the API
nav_order: 5
---

# Using the Inference Studio API

Inference Studio exposes a fully **OpenAI-compatible API** at `/v1`. Any client or library that works with OpenAI will work here. Change only the `base_url` and `api_key`.

## Base URLs

| Access | Base URL |
|--------|----------|
| Local | `http://localhost:3000/v1` |
| Public (tunnel) | `https://xxx-yyy-zzz.trycloudflare.com/v1` |

The tunnel URL is shown on your dashboard and in **Admin → Settings**. It changes each time the deploy script restarts.

---

## Authentication

All requests require an API key in the `Authorization` header:

```
Authorization: Bearer sk-studio-YOUR_KEY_HERE
```

Generate keys at `http://localhost:3000/admin` → **Keys** tab.

**Error response when key is missing or invalid:**
```json
{
  "error": {
    "message": "Invalid API key. Generate one at /admin → Keys.",
    "type": "invalid_request_error",
    "code": "invalid_api_key",
    "param": null
  }
}
```

---

## Chat Completions

`POST /v1/chat/completions`

The primary endpoint. Accepts the same request format as `openai.chat.completions.create`.

### Non-streaming

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "microsoft/Phi-4-mini-instruct",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user",   "content": "What is the capital of France?"}
    ],
    "max_tokens": 100,
    "temperature": 0.7
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "microsoft/Phi-4-mini-instruct",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Paris."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 22,
    "completion_tokens": 3,
    "total_tokens": 25
  }
}
```

### Streaming (SSE)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "microsoft/Phi-4-mini-instruct",
    "messages": [{"role": "user", "content": "Write a haiku about the sea."}],
    "stream": true,
    "max_tokens": 80
  }'
```

**Response (SSE):**
```
data: {"id":"chatcmpl-...","choices":[{"delta":{"role":"assistant","content":""},...}]}

data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"Waves"},...}]}

data: {"id":"chatcmpl-...","choices":[{"delta":{"content":" crash"},...}]}

...

data: {"id":"chatcmpl-...","choices":[{"delta":{},"finish_reason":"stop",...}]}

data: [DONE]
```

---

## Legacy Completions

`POST /v1/completions`

For plain text completion (no message structure). Useful for prompt completion tasks.

```bash
curl http://localhost:3000/v1/completions \
  -H "Authorization: Bearer sk-studio-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "microsoft/Phi-4-mini-instruct",
    "prompt": "The theory of relativity was developed by",
    "max_tokens": 30,
    "temperature": 0.3
  }'
```

---

## List Models

`GET /v1/models`

Returns the currently loaded model.

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-studio-YOUR_KEY"
```

**Response:**
```json
{
  "object": "list",
  "data": [{
    "id": "microsoft/Phi-4-mini-instruct",
    "object": "model",
    "created": 1234567890,
    "owned_by": "vllm"
  }]
}
```

---

## SDK Usage

### Python (openai library)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-studio-YOUR_KEY",
)

# Non-streaming
response = client.chat.completions.create(
    model="microsoft/Phi-4-mini-instruct",
    messages=[
        {"role": "system", "content": "You are a concise assistant."},
        {"role": "user",   "content": "Explain black holes in one sentence."},
    ],
    max_tokens=100,
)
print(response.choices[0].message.content)

# Streaming
with client.chat.completions.stream(
    model="microsoft/Phi-4-mini-instruct",
    messages=[{"role": "user", "content": "Count slowly from 1 to 5."}],
    max_tokens=50,
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### TypeScript (openai SDK)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey:  "sk-studio-YOUR_KEY",
});

// Non-streaming
const response = await client.chat.completions.create({
  model:    "microsoft/Phi-4-mini-instruct",
  messages: [{ role: "user", content: "What is 12 × 13?" }],
});
console.log(response.choices[0].message.content);

// Streaming
const stream = client.beta.chat.completions.stream({
  model:    "microsoft/Phi-4-mini-instruct",
  messages: [{ role: "user", content: "Tell me a short joke." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### Python (httpx, no SDK)

```python
import httpx, json

BASE = "http://localhost:3000/v1"
KEY  = "sk-studio-YOUR_KEY"

with httpx.stream(
    "POST", f"{BASE}/chat/completions",
    headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    json={
        "model":    "microsoft/Phi-4-mini-instruct",
        "messages": [{"role": "user", "content": "Hello!"}],
        "stream":   True,
    },
) as r:
    for line in r.iter_lines():
        if line.startswith("data: ") and line != "data: [DONE]":
            chunk = json.loads(line[6:])
            print(chunk["choices"][0]["delta"].get("content", ""), end="", flush=True)
```

### LangChain

```python
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

llm = ChatOpenAI(
    model="microsoft/Phi-4-mini-instruct",
    openai_api_base="http://localhost:3000/v1",
    openai_api_key="sk-studio-YOUR_KEY",
)

response = llm.invoke([HumanMessage(content="Summarize the water cycle.")])
print(response.content)
```

### n8n / Make / Zapier

Set the **OpenAI base URL** to `http://localhost:3000/v1` (or the tunnel URL for remote workflows) and the **API key** to your `sk-studio-...` key. The model name is the full HuggingFace ID, e.g. `microsoft/Phi-4-mini-instruct`.

---

## Request parameters

All parameters are passed through to vLLM. Common ones:

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Full HuggingFace model ID |
| `messages` | array | Conversation history (chat completions) |
| `prompt` | string | Input text (legacy completions) |
| `stream` | boolean | Enable SSE streaming (default: false) |
| `max_tokens` | integer | Maximum tokens to generate |
| `temperature` | float | Randomness 0–2 (default: 1.0) |
| `top_p` | float | Nucleus sampling cutoff |
| `top_k` | integer | Top-k sampling |
| `stop` | string/array | Stop sequence(s) |
| `n` | integer | Number of completions to generate |
| `presence_penalty` | float | Penalize repeated tokens |
| `frequency_penalty` | float | Penalize frequent tokens |

For the full parameter list, see the [vLLM OpenAI API docs](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html).

---

## External access via Cloudflare tunnel

When the deploy script is running, a public tunnel URL is shown:

```
Public → https://abc-def-ghi.trycloudflare.com
```

Use this URL as the `base_url` to access your inference endpoint from anywhere. No port forwarding or firewall changes needed.

```python
client = OpenAI(
    base_url="https://abc-def-ghi.trycloudflare.com/v1",
    api_key="sk-studio-YOUR_KEY",
)
```

The tunnel is ephemeral. The URL changes each time you restart `deploy-locally.sh`. For a permanent URL, see [Customization → Persistent Cloudflare tunnel](customization.md#persistent-cloudflare-tunnel-named-tunnel).
