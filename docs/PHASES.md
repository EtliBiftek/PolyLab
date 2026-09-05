# PolyLab Development Log

Per-phase progress, test scenarios, and known gaps. A phase is "done" when its
acceptance criteria from the plan are verified.

## Phase 0 — Skeleton

**Status:** done ✓ (2026-09-05)

Delivered:

- pnpm workspace with `apps/desktop` (Electron main + preload) and `apps/renderer`
  (React 18 + TS + Vite + Tailwind).
- Rust sidecar `core` (axum 0.8 + tokio): `GET /health`, `GET /ws` (subprotocol
  `polylab-v1`) with the typed event envelope from `docs/EVENTS.md` (`hello`, `ping`,
  `pong`, `echo`, `error`), bearer-token auth middleware (constant-time compare), token
  via `?token=` accepted for the WS upgrade only.
- Electron main: free-port + random-token generation, sidecar spawn (`cargo run` in dev,
  bundled binary in prod), health polling with timeout, child kill on quit, preload
  bridge (`window.polylab`) with contextIsolation.
- Renderer: claude.ai-style dark theme (red→purple accents), three-pane layout skeleton,
  backend status indicator with live ping RTT, TR/EN i18n switch, Vite dev proxy
  (`/api`, `/health`, `/ws`) so the renderer also runs in a plain browser.

Test scenarios (verified):

1. `cargo test` in `core/` — auth middleware (401 without/with wrong token, 200 with
   correct token), config parsing, event envelope round-trip, WS integration test over a
   real ephemeral socket (hello → ping/pong → echo → malformed → error event).
2. `pnpm build` — all packages typecheck/build.
3. Browser preview with the sidecar running: status badge shows "Backend bağlı ✓" with
   live latency; language switch TR↔EN updates every UI string; killing the sidecar
   flips the badge to offline and it recovers with auto-reconnect.

Known gaps (deliberate, per plan):

- Chat composer, model picker, and Chat/Coding switch are visual only (Phase 1+ wires
  them to real providers/conversations).
- Sidecar crash-restart is not wired yet (planned for a later phase, plan §8 Phase 7).
- Packaging (`pnpm package`) must run on Windows where the Rust binary is
  `polylab-core.exe`; extraResources already expects it.

## Phase 1 — Providers + single-model chat + persistence

**Status:** done ✓ (2026-09-05)

Delivered:

- **Provider layer** (`core/src/providers/`): `Provider` trait + factory;
  `openai_compat` (OpenAI, OpenRouter, DeepSeek, Groq, Mistral, xAI, LM Studio,
  Ollama `/v1`, Custom), `anthropic` (Messages API SSE incl. `thinking_delta`),
  `gemini` (`streamGenerateContent?alt=sse` incl. `thought` parts), `ollama_native`
  (`/api/tags` listing; chat via `/v1`). Native reasoning normalized from
  `reasoning_content` / `reasoning` / `thinking` / `thought` plus a streaming
  `<think>…</think>` filter (state machine, unit-tested, stray-close-tag handling).
- **Storage**: sqlx SQLite (runtime queries; hand-rolled migrator — avoids sqlx's
  macro/migrate features that pull every backend). Migration 0001: providers, models,
  conversations, messages, settings, folders.
- **Secrets**: `keyring` feature (default, Windows Credential Manager) with a
  sandbox-only file fallback (`--no-default-features`) that warns loudly.
- **Engine**: single-model streaming run — prompt build (`prompts/chat.md` embedded +
  env-overridable), 40-message history cap, cancellation (partial results persisted),
  usage from provider or CJK-aware estimate (`estimated` flag), auto title (first 40
  chars), hub broadcast of `message_start`/`token`/`reasoning_token`/`usage`/
  `message_done`.
- **WS hub**: broadcast fan-out to all connected clients; inbound `send_message` /
  `cancel` dispatched to the engine.
- **REST**: provider CRUD + test + remote-models, model CRUD (upsert-on-enable),
  conversation CRUD + messages, settings kv.
- **Renderer**: working chat screen (streaming answers with markdown, usage line,
  Thinking panel with native reasoning), model picker grouped by provider, settings
  modal (add provider, API key → keyring, test connection, enable/disable models),
  sidebar with live conversations + search + delete, functional composer
  (Ctrl+Enter, stop button), auto-reconnect WS wiring for chat events.
- `scripts/mock-provider.mjs` — OpenAI-compatible mock provider for demo/dev runs.

Test scenarios (verified):

1. `cargo test` (core): 32 tests — auth, config, events envelope, migrations,
   ThinkFilter (7 cases incl. split tags, stray close tags, char-by-char),
   openai_compat list/stream normalization, full API flow against a mock provider
   (provider CRUD → test → model → conversation → engine run → hub events →
   persisted content/reasoning/usage/title), provider-delete cascade, settings.
2. `pnpm test` (renderer): app smoke — mount, backend badge, TR/EN switch, composer.
3. Sandbox end-to-end against the mock provider through the Vite proxy:
   streaming tokens + reasoning + exact usage; cancellation persists partial output;
   history reload works.
4. Real cloud/local providers (LM Studio, DeepSeek R1) need a machine with network
   access to those services — verified against the mock with identical code paths.

Known gaps (deliberate, per plan):

- Groups/model groups and debate events: Phase 2. Model color/temperature editing UI:
  Phase 3. Attachments: Phase 3.
- Conversation rename/folders/pin UI: Phase 3 (backend columns already exist).
- Auto title is first-40-chars only (model-generated titles were left as an option
  for later polish).
- `keyring` (Credential Manager) path compiles only on machines with crates.io
  access; the sandbox/CI fallback store is used here and clearly warns.
