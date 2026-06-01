# Inference Studio

Self-hosted LLM inference with a web interface and OpenAI-compatible API.

```bash
git clone https://github.com/your-org/vLLM-harness
cd vLLM-harness
bash deploy-locally.sh
```

The script installs Docker and the NVIDIA Container Toolkit if absent, builds the services, and opens `http://localhost:3000`, where you pick a model and wait for it to load. The endpoint is then live locally and via an automatically started Cloudflare Quick Tunnel, with no account and no port forwarding required. The API follows the OpenAI chat completions format at `/v1`, so any client that targets the OpenAI SDK will work here with `base_url` set to your local or tunnel URL and an API key from the admin panel. Default credentials are **admin** / **password** and should be changed immediately at `/admin`.

## Documentation

- [Features](docs/features.md)
- [API Reference](docs/api-reference.md)
- [Customization](docs/customization.md)
- [Setup & Troubleshooting](guides/setup-and-troubleshooting.md)

## License

MIT

---

## Attestation

This project was built in collaboration with Claude Sonnet 4.6 (Anthropic).

[![Attested by Claude Sonnet 4.6](https://attest.97115104.com/badge/cy1a0o3x)](https://attest.97115104.com/s/cy1a0o3x)

Verify: [attest.97115104.com/s/cy1a0o3x](https://attest.97115104.com/s/cy1a0o3x)
