# PolyLab Architecture

This document is the canonical architecture reference for PolyLab. It is derived from the
development plan and must be updated **before** the code when a contract changes.

## 1. Overview

PolyLab is a Windows desktop application (Linux/macOS ports are future work) that lets a user
talk to a single AI model or to a **group of models** that debate in rounds and produce a
single synthesized answer. It has two modes:

- **Chat** — conversations with one model or a debate group.
- **Coding** — an agent loop that reads/writes a local project folder (optional terminal
  access), with proposed changes requiring user approval.

## 2. Process topology

```
┌──────────────────────────────────────────────────────┐
│ Electron Main Process (TypeScript)                   │
│  • Spawns the Rust sidecar (random port + token)     │
│  • Window management, native dialogs                 │
│  • contextBridge → safe bridge to the renderer       │
└───────────────┬──────────────────────────────────────┘
                │ IPC (contextBridge)
┌───────────────▼──────────────────────────────────────┐
│ Renderer (React + Vite)                              │
│  • WebSocket: ws://127.0.0.1:{port}/ws?token=...     │
│  • REST:      http://127.0.0.1:{port}/api/...        │
└───────────────┬──────────────────────────────────────┘
                │ WS (streaming events) + REST (CRUD)
┌───────────────▼──────────────────────────────────────┐
│ Rust Sidecar (polylab-core)                          │
│  providers/ · debate/ · agent/ · storage/ · fs/ ·    │
│  git/ · terminal/ · secrets/                         │
└──────────────────────────────────────────────────────┘
```

### 2.1 Sidecar lifecycle

1. Electron main generates a 48-hex-char session **token** and asks the OS for a free **TCP
   port** (bind to port 0, read back, release).
2. It spawns `polylab-core`:
   - **dev:** `cargo run --bin polylab-core` inside `core/`
   - **prod:** `process.resourcesPath/bin/polylab-core(.exe)` (bundled via
     `electron-builder` `extraResources`)
   - Environment: `POLYLAB_PORT` (the chosen port) and `POLYLAB_TOKEN` (the session token).
3. Main polls `GET /health` with `Authorization: Bearer <token>` until it answers `200`
   (or times out).
4. The token + port are handed to the renderer through the preload bridge.
5. When Electron quits, the child process is killed (job object / SIGTERM, then kill).
   If the sidecar dies unexpectedly, main restarts it and re-broadcasts the new port/token
   (wired in a later phase; see `docs/PHASES.md`).

### 2.2 Security model

- The sidecar **only** binds to `127.0.0.1`. It never accepts remote connections.
- Every HTTP request must carry `Authorization: Bearer <token>`. The single WebSocket
   endpoint accepts the token as a `?token=` query parameter (browser WebSocket cannot set
   headers). Comparison is constant-time.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  All native capabilities (dialogs, folder pickers, …) go through the preload bridge.
- API keys are stored only in the OS credential manager (Windows Credential Manager via the
  `keyring` crate), never in SQLite, logs, or exports.
- File operations in Coding mode are sandboxed to the chosen project root (canonicalize +
  prefix check; symlink escape checks).

## 3. Repository layout

```
polylab/
├─ package.json                  # pnpm workspace root
├─ electron-builder.yml
├─ apps/
│  ├─ desktop/                   # Electron main + preload
│  │  ├─ src/main.ts             # sidecar spawn, window, menu
│  │  ├─ src/preload.ts          # contextBridge API
│  │  └─ src/sidecar.ts          # port/token generation, health check, restart
│  └─ renderer/                  # React application
│     ├─ src/
│     │  ├─ app/                 # router, providers, layout
│     │  ├─ components/          # sidebar/ chat/ thinking/ models/ coding/ artifacts/ ui/
│     │  ├─ stores/              # zustand stores: chat, models, debate, coding, settings
│     │  ├─ lib/ws.ts            # WS client + event dispatch
│     │  ├─ lib/api.ts           # REST client
│     │  ├─ i18n/{tr,en}.json
│     │  └─ styles/theme.css     # color variables
│     └─ index.html
├─ core/                          # Rust sidecar
│  ├─ Cargo.toml
│  ├─ src/main.rs                # axum server, router, auth middleware
│  ├─ src/ws.rs                  # WebSocket hub, event broadcast
│  ├─ src/api/                   # REST handlers
│  ├─ src/providers/             # Provider trait + implementations (Phase 1+)
│  ├─ src/debate/                # debate engine (Phase 2+)
│  ├─ src/agent/                 # coding agent loop (tool protocol, approvals)
│  ├─ src/fs.rs                  # sandboxed workspace file ops
│  ├─ src/git.rs  src/terminal.rs # git CLI wrapper + one-shot terminal
│  ├─ src/storage/               # SQLite via sqlx (Phase 1)
│  ├─ src/secrets.rs             # keyring (Phase 1)
│  └─ src/tokens.rs              # token counting
├─ prompts/                       # editable system prompts (markdown)
└─ docs/                          # ARCHITECTURE.md · EVENTS.md · PHASES.md
```

Modules appear as the phases that need them land; do not create empty stubs ahead of time.

## 4. Technology decisions

| Layer | Choice |
|---|---|
| Desktop shell | Electron 30+ |
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + CSS custom properties |
| State | Zustand |
| Code editor | Monaco (`@monaco-editor/react`) — Coding mode |
| Terminal UI | xterm.js — Coding mode |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` |
| i18n | `i18next` + `react-i18next` (TR + EN) |
| Backend | Rust sidecar (`polylab-core`) |
| Rust server | `axum` + `tokio` + `tokio-tungstenite` |
| HTTP client | `reqwest` (streaming) + `eventsource-stream` |
| Database | SQLite via `sqlx` |
| Secrets | `keyring` → Windows Credential Manager |
| Git | `git2` |
| Terminal | `portable-pty` |
| File watching | `notify` |
| Token counting | `tiktoken-rs` + provider `usage` fields |
| Packaging | `electron-builder` (NSIS, Windows x64), Rust binary in `extraResources` |

## 5. Data model (SQLite, introduced in Phase 1+)

```sql
providers        (id, kind, name, base_url, enabled, created_at)
models           (id, provider_id, model_id, display_name, color, temperature,
                  max_tokens, system_prompt_override, supports_vision, supports_tools,
                  supports_reasoning, enabled)
model_groups     (id, name, description, created_at)
model_group_items(group_id, model_id, position)
conversations    (id, title, mode, selection_type, model_id, group_id,
                  debate_settings_json, project_path, folder_id, pinned, created_at, updated_at)
messages         (id, conversation_id, role, content, attachments_json, created_at)
debates          (id, message_id, status, rounds_total, consensus_reached,
                  leader_model_id, total_tokens_in, total_tokens_out, started_at, ended_at)
debate_turns     (id, debate_id, round, model_id, anon_label, content, reasoning,
                  tokens_in, tokens_out, phase, created_at)
agent_runs       (id, message_id, status, permission_level, steps_json, tokens_in, tokens_out)
pending_changes  (id, conversation_id, file_path, old_content, new_content, status, created_at)
settings         (key, value_json)
folders          (id, name, position)
```

API keys are **not** in any table; they live in the credential manager under
`polylab/provider/{id}`.

## 6. Core algorithms (references into the plan)

- **Provider layer** — one `Provider` trait (`list_models`, `stream_chat`, `capabilities`);
  a single OpenAI-compatible implementation covers OpenAI/OpenRouter/DeepSeek/Groq/Mistral/
  xAI/LM Studio/Ollama-v1/Custom; dedicated implementations for Anthropic, Gemini, and
  Ollama-native. Native reasoning (`reasoning_content`, `thinking` blocks, `<think>` tags,
  OpenAI reasoning summaries) is normalized in `providers/reasoning.rs`.
- **Debate engine** — anonymized labels (Model A/B/C), parallel rounds
  (initial → critique/revise → …), consensus detection via a final `CONSENSUS: yes|no`
  line, leader synthesis. Full flow lives in the plan §5.2.
- **Coding agent** — low-token context strategy (shortened file tree + root manifest files,
  the model explores by itself with `search_in_files`/`read_file`), permission levels
  (`read_write` / `full`), pending changes with diffs and approval, optional multi-model
  writer/reviewer flow. Full flow lives in the plan §5.3–5.4.

## 7. Theme

claude.ai light theme: warm ivory canvas, oat sidebar, terracotta accent, charcoal
pill buttons. Canonical variables in `apps/renderer/src/styles/theme.css`:

```css
:root {
  --bg-0: #f5f4ee;  --bg-1: #f0eee6;  --bg-2: #e9e7de;  --bg-3: #ddd9cc;
  --bg-invert: #262624;                       /* charcoal: send btn, active pills */
  --text-0: #1f1e1d; --text-1: #3d3d3a; --text-2: #83827d;
  --accent: #d97757;  --accent-2: #c4633f;    /* Claude terracotta */
  --border: #e0ded4; --success: #3f8f5b; --warn: #c77d1e; --danger: #bf4d43;
}
```

Layout notes: borderless top bar with a pill segmented Chat/Coding control (white
active segment), white composer card with dark circular send button, user messages
as white bubbles right-aligned, serif greeting on the empty state, ✻-style starburst
logo mark.

## 8. Development

Prerequisites: Node ≥ 20, pnpm ≥ 9, Rust stable (with cargo), Git.

```bash
pnpm install            # workspace install (Electron binary downloads on first run)
cargo test              # core unit + integration tests (run inside core/)
pnpm build              # typecheck/build all packages
pnpm dev                # renderer (Vite) + Electron shell; Electron spawns the sidecar
```

Renderer-only development (no Electron, e.g. in a browser):

```bash
pnpm dev:core           # sidecar on 127.0.0.1:43110 with dev token "dev-token"
pnpm dev:renderer       # Vite proxies /api, /health and /ws (WS) to the sidecar
```

The dev token fallback exists **only** for browser development; the sidecar still binds to
127.0.0.1 only.
