# PolyLab WebSocket Event Contract

Version: 0.1 (Phase 0). This file is the single source of truth for the WebSocket protocol
between the renderer and `polylab-core`. When the contract changes, update this document
**first**, then the code.

## 1. Transport & envelope

- Single endpoint: `GET ws://127.0.0.1:{port}/ws?token={sessionToken}`
  (subprotocol `polylab-v1`). Browsers cannot set headers on WebSocket, hence the query
  parameter. The REST API uses `Authorization: Bearer {sessionToken}` instead.
- Both directions carry **UTF-8 JSON text frames**. Every frame is an event object with a
  discriminating `type` field (`snake_case`) plus a flat payload:

```json
{ "type": "debate_turn_token", "debate_id": 42, "round": 2, "model_id": 7, "delta": "..." }
```

- Unknown event types must be **ignored**, not treated as errors (forward compatibility).
- Server → client events always belong to a conversation where applicable and carry
  `conversation_id`, so the UI can render only the open conversation and buffer the rest.
- Errors are always delivered as `error` events over WS (never a bare close), except
  authentication failure, which closes/rejects the socket with HTTP 401 during the upgrade.

## 2. Connection lifecycle

1. On connect the server immediately sends `hello`.
2. The client may send `ping` at any time; the server answers `pong` (used for liveness
   and RTT display). When the sidecar restarts with a new port/token the client must
   re-connect with the new credentials (broadcast via IPC).
3. In-flight work survives renderer reloads (the sidecar owns it) and is cancelled
   explicitly with `cancel`.

## 3. Client → Server

| Event | Payload | Phase |
|---|---|---|
| `ping` | — | 0 |
| `echo` | `text: string` (loopback test event) | 0 |
| `send_message` | `conversation_id, content, attachments[]` | 1 |
| `cancel` | `conversation_id` | 1 |
| `approve_change` | `change_id, accept: bool` | 4 |
| `approve_tool` | `run_id, step_id, accept: bool` (terminal approval) | 5 |
| `terminal_input` | `session_id, data` | 5 |

## 4. Server → Client

| Event | Payload | Phase |
|---|---|---|
| `hello` | `name, version` | 0 |
| `pong` | — | 0 |
| `echo` | `text: string` | 0 |
| `error` | `conversation_id?, message_id?, code, detail` | 0 |
| `message_start` | `conversation_id, message_id, model_id, mode: single\|debate\|agent` | 1 |
| `token` | `conversation_id, message_id, delta` (final answer stream) | 1 |
| `reasoning_token` | `conversation_id, message_id, model_id, delta` (only when the model's think toggle is on) | 1 |
| `usage` | `conversation_id, message_id, tokens_in, tokens_out, estimated: bool` | 1 |
| `message_done` | `conversation_id, message_id, status: done\|cancelled\|error` | 1 |
| `debate_round_start` | `conversation_id, debate_id, round, phase` | 2 |
| `debate_turn_token` | `conversation_id, debate_id, round, model_id, anon_label, delta` | 2 |
| `debate_turn_done` | `conversation_id, debate_id, round, model_id, tokens_in, tokens_out` | 2 |
| `debate_consensus` | `conversation_id, debate_id, reached: bool, reason` | 2 |
| `debate_done` | `conversation_id, debate_id, total_tokens_in, total_tokens_out` | 2 |
| `agent_step` | `conversation_id, run_id, step_id, tool, args, status: running\|done\|error\|needs_approval` | 4 |
| `file_change_proposed` | `conversation_id, change_id, path, diff` | 4 |
| `terminal_output` | `conversation_id, session_id, data` | 5 |

Debate `phase` values: `initial` · `critique` · `revise` · `synthesis`.
(Plan §5.2 folds critique+revise into one round step; the wire format distinguishes them so
the Thinking panel can label streams precisely. `critique` phases are emitted when
participant output includes critique text before the revised answer.)

## 5. Error codes

| Code | Meaning |
|---|---|
| `unauthorized` | missing/invalid session token |
| `bad_request` | malformed event or payload |
| `internal` | unexpected sidecar failure |
| `provider_error` | upstream provider failed (payload has provider detail) |
| `rate_limited` | upstream rate limit (retry scheduled) |
| `timeout` | model/round timed out and was dropped |
| `cancelled` | work was cancelled by the user |

## 6. REST endpoints (companion contract)

Prefixed with `/api` except `/health`:

| Endpoint | Purpose | Phase |
|---|---|---|
| `GET /health` | liveness probe used by Electron main | 0 |
| `GET/POST /api/providers`, `GET/PATCH/DELETE /api/providers/{id}` | provider CRUD (`has_api_key` in DTOs; keys never returned) | 1 |
| `GET /api/providers/{id}/test` | connection test (`{ok, model_count?, detail?}`) | 1 |
| `GET /api/providers/{id}/remote-models` | live model listing with `added` flags | 1 |
| `GET/POST /api/models`, `GET/PATCH/DELETE /api/models/{id}` | local model catalog | 1 |
| `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/{id}` | conversations (`GET {id}` includes messages) | 1 |
| `GET/PUT /api/settings` | key/value settings (JSON values) | 1 |
| `GET /api/debates?message_id=` | replay full debate for Thinking panel | 2 |
| file tree/read/search | coding right panel (also as agent tools) | 4 |
| git/terminal session setup | coding full permission | 5 |

All REST responses are JSON: either the payload object or
`{ "error": { "code": "...", "detail": "..." } }` with an appropriate HTTP status.
