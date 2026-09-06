import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { fsList, fsRead, gitCommit, gitOp } from "../../lib/api";
import { useChat } from "../../stores/chat";
import { extractCodeBlocks, useArtifacts } from "../../stores/artifacts";
import { useSettings } from "../../stores/settings";
import { CloseIcon, RefreshIcon } from "../ui/Icons";

type Tab = "artifacts" | "files" | "git" | "terminal";

/** Right side panel: artifacts (F3), workspace files + git + terminal (F4/F5). */
export function RightPanel() {
  const { t } = useTranslation();
  const toggleRightPanel = useSettings((s) => s.toggleRightPanel);
  const mode = useSettings((s) => s.mode);
  const activeId = useChat((s) => s.activeId);
  const conversation = useChat((s) =>
    s.conversations.find((entry) => entry.id === s.activeId),
  );
  const [tab, setTab] = useState<Tab>(mode === "coding" ? "files" : "artifacts");

  useEffect(() => {
    setTab(mode === "coding" ? "files" : "artifacts");
  }, [mode]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "artifacts", label: t("artifacts.tab") },
    { id: "files", label: t("files.tab") },
    { id: "git", label: t("git.tab") },
    { id: "terminal", label: t("terminal.tab") },
  ];

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex gap-0.5">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              aria-pressed={tab === entry.id}
              className={`h-7 rounded-full px-2.5 text-[12px] font-medium transition ${
                tab === entry.id
                  ? "bg-bg-invert text-txt-invert"
                  : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggleRightPanel}
          title={t("common.close")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {activeId == null ? (
        <div className="flex flex-1 items-center justify-center px-8">
          <p className="text-center text-[13px] leading-relaxed text-txt-2">
            {t("artifacts.empty")}
          </p>
        </div>
      ) : tab === "artifacts" ? (
        <ArtifactsTab />
      ) : tab === "files" ? (
        <FilesTab conversationId={activeId} />
      ) : tab === "git" ? (
        <GitTab conversationId={activeId} />
      ) : (
        <TerminalTab />
      )}

      {conversation?.mode === "coding" && tab === "terminal" && null}
    </aside>
  );
}

/* ---------------------------------------------------------------- artifacts */

function ArtifactsTab() {
  const { t } = useTranslation();
  const artifacts = useArtifacts((s) => s.artifacts);
  const activeId = useArtifacts((s) => s.activeId);
  const open = useArtifacts((s) => s.open);
  const register = useArtifacts((s) => s.register);
  const clearConversation = useArtifacts((s) => s.clearConversation);
  const conversationId = useChat((s) => s.activeId);
  // Store-driven: re-extracts when history loads AND when a streamed message is
  // finalized (message_done reloads `messages`), so already-open conversations
  // refresh their artifact list without switching chats.
  const messages = useChat((s) => (conversationId != null ? s.messages[conversationId] : undefined));

  // Artifacts are per-conversation: drop the previous chat's blocks before
  // re-extracting the current one (which survives reloads from history).
  useEffect(() => {
    clearConversation();
    if (conversationId == null || messages == null) return;
    for (const message of messages) {
      if (message.role === "assistant" && message.content.includes("```")) {
        register(message.id, extractCodeBlocks(message.content));
      }
    }
  }, [conversationId, messages, register, clearConversation]);

  const active = artifacts.find((artifact) => artifact.id === activeId) ?? artifacts[0];

  if (artifacts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-8">
        <p className="text-center text-[13px] leading-relaxed text-txt-2">
          {t("artifacts.emptyHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-border p-1.5">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => open(artifact.id)}
            className={`h-7 shrink-0 rounded-full px-2.5 text-[11.5px] font-medium transition ${
              artifact.id === active?.id
                ? "bg-bg-3 text-txt-0"
                : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
            }`}
            title={artifact.title}
          >
            {artifact.language} · {artifact.title.slice(0, 18)}
          </button>
        ))}
      </div>
      {active != null && (
        <>
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-txt-2">
            <span className="font-mono">{active.language}</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(active.code)}
              className="rounded px-1.5 py-0.5 hover:bg-bg-2 hover:text-txt-0"
            >
              {t("artifacts.copy")}
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto bg-bg-0 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-txt-1">
            {active.code}
          </pre>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- files */

function FilesTab({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<string>("");
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fsList(conversationId, path);
      setListing(response.content);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload("");
    setFile(null);
  }, [conversationId]);

  const lines = useMemo(() => listing.split("\n").filter(Boolean), [listing]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] text-txt-2">
          {file != null ? file.path : t("files.workspace")}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          title={t("common.refresh")}
          onClick={() => (file != null ? setFile(null) : void reload(""))}
          className="flex h-6 w-6 items-center justify-center rounded text-txt-2 hover:bg-bg-2 hover:text-txt-0"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {error != null && <p className="px-3 py-2 text-[12px] text-danger">{error}</p>}
      {file != null ? (
        <pre className="min-h-0 flex-1 overflow-auto bg-bg-0 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-txt-1">
          {file.content}
        </pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {loading && <p className="px-2 py-1 text-[12px] text-txt-2">…</p>}
          {lines.map((line) => {
            const isDir = line.endsWith("/");
            const path = line.replace(/\/$/, "");
            return (
              <button
                key={line}
                type="button"
                disabled={isDir}
                onClick={() =>
                  void fsRead(conversationId, path)
                    .then((response) => setFile({ path, content: response.content }))
                    .catch((caught) => setError(String(caught)))
                }
                className={`block w-full truncate rounded-md px-2 py-1 text-left font-mono text-[11.5px] ${
                  isDir ? "text-txt-2" : "text-txt-1 hover:bg-bg-2 hover:text-txt-0"
                }`}
              >
                {line}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- git */

function GitTab({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const [op, setOp] = useState<"status" | "diff" | "log">("status");
  const [state, setState] = useState<{ repo: boolean; output: string } | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);

  const reload = (nextOp: "status" | "diff" | "log") => {
    void gitOp(conversationId, nextOp)
      .then(setState)
      .catch((caught) => setState({ repo: false, output: String(caught) }));
  };

  useEffect(() => {
    reload(op);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, op]);

  const dirty = state?.repo === true && !(state.output.includes("(clean)") || state.output.trim() === "");

  const commit = async () => {
    if (commitMessage.trim().length === 0) return;
    setCommitting(true);
    try {
      await gitCommit(conversationId, commitMessage.trim());
      setCommitMessage("");
      reload(op);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-0.5 border-b border-border p-1.5">
        {(["status", "diff", "log"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setOp(value)}
            className={`h-6 rounded-full px-2.5 text-[11.5px] transition ${
              op === value ? "bg-bg-3 text-txt-0" : "text-txt-2 hover:bg-bg-2"
            }`}
          >
            {t(`git.${value}`)}
          </button>
        ))}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-bg-0 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-txt-1">
        {state == null ? "…" : state.repo ? state.output : t("git.notRepo")}
      </pre>
      {dirty && (
        <div className="flex items-center gap-1.5 border-t border-border p-2">
          <input
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commit();
            }}
            placeholder={t("git.commitPlaceholder")}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[12px] text-txt-0 placeholder:text-txt-2 focus:outline-none"
          />
          <button
            type="button"
            disabled={committing || commitMessage.trim().length === 0}
            onClick={() => void commit()}
            className="h-8 shrink-0 rounded-full bg-bg-invert px-3 text-[12px] font-medium text-txt-invert transition hover:bg-invert-hover disabled:opacity-40"
          >
            {committing ? "…" : t("git.commit")}
          </button>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- terminal */

function TerminalTab() {
  const { t } = useTranslation();
  const activeId = useChat((s) => s.activeId);
  const terminal = useChat((s) => (activeId != null ? s.terminal[activeId] : undefined));
  const runCommand = useChat((s) => s.runCommand);
  const killTerminal = useChat((s) => s.killTerminal);
  const [command, setCommand] = useState("");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-auto bg-bg-0 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-txt-1"
        data-testid="terminal-output"
      >
        {(terminal?.lines ?? []).map((line, index) => (
          <pre key={index} className="whitespace-pre-wrap">
            {line}
          </pre>
        ))}
        {terminal?.running && <span className="animate-pulse">▍</span>}
      </div>
      <div className="flex items-center gap-2 border-t border-border p-2">
        <span className="font-mono text-[12px] text-accent">$</span>
        {terminal?.started === true && (
          <button
            type="button"
            onClick={killTerminal}
            title={t("terminal.kill")}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-txt-2 transition hover:text-danger"
          >
            ⏹
          </button>
        )}
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && command.trim().length > 0) {
              runCommand(command.trim());
              setCommand("");
            }
          }}
          placeholder={t("terminal.placeholder")}
          className="h-8 flex-1 rounded-md border border-border bg-surface px-2 font-mono text-[12px] text-txt-0 placeholder:text-txt-2 focus:outline-none"
        />
      </div>
    </div>
  );
}
