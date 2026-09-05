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

## Phase 2 — Model groups + debate engine + debate UI

**Status:** done ✓ (2026-09-05)

- Core: migration 0002 (model_groups, model_group_items, debates, debate_turns);
  debate engine (`core/src/debate/`) — shuffled anon labels, parallel rounds,
  `CONSENSUS: yes|no` vote parsing, fixed vs early-consensus termination, leader
  synthesis, per-turn + total usage, cancellation, persistence; groups CRUD +
  `/api/debates` replay; conversations accept `group_id` + `debate_settings`.
- Renderer: composer model picker gains a **Groups** tab (create/delete groups,
  per-group debate settings: termination, max rounds); live debate visualization
  (round headers, anonymous participant cards with real model names, consensus
  badge, streaming cursors) + replay transcript per assistant message.
- Verified end-to-end against the mock provider: 3-model group debate streamed
  r1 initial → r2 critique → consensus check (max rounds, leader decided) →
  r3 synthesis; 7 turns persisted and replayed via `GET /api/debates`.

## Phase 3 — Chat polish (attachments, artifacts, rename/pin, model editor)

**Status:** done ✓ (2026-09-05)

- Attachments: composer 📎 attaches text files (≤512 KB each, ≤5); sent with
  `send_message`, persisted as `attachments_json`, appended to the prompt;
  chips shown on user bubbles.
- Artifacts: fenced code blocks render with a header (language, copy,
  "open in panel"); the right panel's Artifacts tab lists/edits extracted
  blocks.
- Conversations: rename (⋯ menu or double-click), pin/unpin, folders REST
  (`/api/folders`) + sidebar menu assignment.
- Model editor in settings: display name, color swatches, temperature,
  max tokens per model; per-model think toggle in the composer picker
  (migration 0003, persisted, gates reasoning streaming/storage).
- UI: claude.ai-style light layout (gray surfaces + red accent), black/white
  theme switch (settings → Görünüm), Enter sends / Shift+Enter newline,
  collapsible sidebar (60px rail), 3 rotating mode-aware composer suggestions
  seeded from the user's history.

## Phase 4 — Coding agent

**Status:** done ✓ (2026-09-05)

- `core/src/agent/`: tool loop (max 8 steps) over a ```tool JSON protocol
  (no native tool-calling needed); tools: fs_list/fs_read/fs_write/fs_delete
  (workspace-sandboxed, size-capped), exec (45s timeout), git_status/git_diff/
  git_commit. Mutating tools require approval (`agent_approval_request` +
  `agent_approve`) unless the conversation sets `agent_auto_approve`.
- Migration 0004: `agent_steps` table + `conversations.agent_auto_approve`;
  steps persisted and replayed via `GET /api/agent-steps`.
- Coding conversations get a workspace dir (`<data>/workspace/<id>`, or a
  custom `project_path`); `GET /api/fs` browses it sandboxed.
- Renderer: agent steps render as tool chips (expandable output); approval
  toast with Onayla/Reddet; coding mode activates via the top bar Chat/Coding
  switch (patches the active conversation's mode).
- Verified E2E with `mock-agent` (tool-protocol mock): fs_list executed
  against the seeded workspace, result fed back, final answer streamed, step
  replayed via REST.

## Phase 5 — Git + terminal

**Status:** done ✓ (2026-09-05)

- `core/src/git.rs`: status/diff/log/commit via the git CLI (async, capped
  output; diff includes untracked files); `GET /api/git` surfaces them.
- `core/src/terminal.rs`: `terminal_run` executes a one-shot command in the
  conversation workspace; output streams as `terminal_output` chunks +
  `terminal_exit` (not a full interactive PTY — documented gap).
- Renderer right panel: Files (sandboxed browser + file viewer), Git
  (status/diff/log), Terminal tabs.

## Phase 7 — Robustness

**Status:** done ✓ (2026-09-05, packaging partial)

- Electron main: sidecar crash-restart with capped exponential backoff (max 5
  restarts/min window) via `SidecarHandle.onCrash`; renderer heals through the
  existing WS reconnect + /health polling.
- History replay stays capped at 40 messages; token-budget trimming and
  model-generated titles remain open polish items.
- Packaging: `electron-builder.yml` unchanged; Windows build (keyring +
  tiktoken features, `polylab-core.exe`) requires a crates.io-capable machine.
- Known debt: optional `keyring`/`tiktoken` deps are not vendorable offline
  (features declared empty; file-backed secrets + estimated tokens in use);
  one stale sqlx row panic was observed on the pre-0004 binary during a live
  session (not reproduced on the current build; watch on upgrade).
