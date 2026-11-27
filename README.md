# codex-openai-compatible-endpoint

An OpenAI-compatible HTTP API that answers requests by running the [Codex CLI](https://github.com/openai/codex) with **your ChatGPT/Codex subscription**. Point any OpenAI SDK or tool at it. It also has a web UI to create and revoke API keys.

No dependencies. Needs Node 20+ and a logged-in `codex` (`codex login`).

## Run

```sh
npm start                 # http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787/admin`, log in, and create a key. The admin password comes from `ADMIN_PASSWORD`. If it isn't set, one is generated on first start, printed, and saved in `data/admin-password`.

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-codex-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"hello"}]}'
```

## Endpoints

| Endpoint | Notes |
|---|---|
| `GET /v1/models` | Models from your local Codex model cache |
| `POST /v1/chat/completions` | `stream: true` supported (the reply is sent as one chunk once Codex finishes) |
| `POST /v1/responses` | Basic text input/output |
| `/admin` | Key management UI |

## Settings (environment variables)

`PORT` (8787), `HOST` (127.0.0.1; comma-separated list allowed), `DATA_DIR` (./data), `ADMIN_PASSWORD`, `MAX_CONCURRENCY` (4), `CODEX_TIMEOUT_MS` (300000), `CODEX_BIN` (codex).

## How it works and limits

- Each request runs `codex exec --ephemeral --sandbox read-only` in an empty temp folder, so the model answers as plain chat and cannot touch your files.
- API keys are stored as SHA-256 hashes in `data/keys.json`; the full key is shown once.
- Not supported: tool/function calling, images, true token streaming, `temperature` and other sampling parameters. Each request carries Codex's own system prompt, so token counts are higher than for the plain API.
- Usage counts against your Codex subscription limits. Check that this use is allowed by OpenAI's terms for your plan.
- It binds to localhost. Put HTTPS and a reverse proxy in front of it before exposing it to a network.

## Run as a service

`deploy/codex-endpoint.service` is a systemd unit (edit the user and paths first):

```sh
sudo cp deploy/codex-endpoint.service /etc/systemd/system/
sudo systemctl enable --now codex-endpoint
```

## Test

```sh
npm test
```
