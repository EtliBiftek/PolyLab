import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import type { Provider, RemoteModel, TestResult } from "../../lib/api";
import { listConversations, getConversation } from "../../lib/api";
import { bridge } from "../../lib/backend";
import { useConnection } from "../../stores/connection";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { Button } from "../ui/Button";
import {
  CheckIcon,
  CloseIcon,
  EyeIcon,
  PlusSquareIcon,
  RefreshIcon,
  TrashIcon,
} from "../ui/Icons";

const PROVIDER_KINDS = [
  { id: "openai", defaultBase: "https://api.openai.com/v1", needsKey: true },
  { id: "anthropic", defaultBase: "https://api.anthropic.com", needsKey: true },
  { id: "gemini", defaultBase: "https://generativelanguage.googleapis.com", needsKey: true },
  { id: "openrouter", defaultBase: "https://openrouter.ai/api/v1", needsKey: true },
  { id: "deepseek", defaultBase: "https://api.deepseek.com/v1", needsKey: true },
  { id: "groq", defaultBase: "https://api.groq.com/openai/v1", needsKey: true },
  { id: "mistral", defaultBase: "https://api.mistral.ai/v1", needsKey: true },
  { id: "xai", defaultBase: "https://api.x.ai/v1", needsKey: true },
  { id: "lmstudio", defaultBase: "http://localhost:1234/v1", needsKey: false },
  { id: "ollama", defaultBase: "http://localhost:11434", needsKey: false },
  { id: "custom", defaultBase: "", needsKey: false },
] as const;

export function SettingsModal() {
  const { t } = useTranslation();
  const sendOnEnter = useSettings((state) => state.sendOnEnter);
  const setSendOnEnter = useSettings((state) => state.setSendOnEnter);
  const showTimestamps = useSettings((state) => state.showTimestamps);
  const setShowTimestamps = useSettings((state) => state.setShowTimestamps);
  const coreVersion = useConnection((state) => state.coreVersion);
  const [exporting, setExporting] = useState(false);

  /** Exports every conversation with its full message history as one JSON file. */
  const exportData = async () => {
    setExporting(true);
    try {
      const conversations = await listConversations();
      const payload = [];
      for (const conversation of conversations) {
        const detail = await getConversation(conversation.id);
        payload.push({ ...conversation, messages: detail.messages });
      }
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), conversations: payload }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `polylab-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };
  const open = useSettings((state) => state.settingsOpen);
  const setOpen = useSettings((state) => state.setSettingsOpen);
  const language = useSettings((state) => state.language);
  const setLanguage = useSettings((state) => state.setLanguage);
  const theme = useSettings((state) => state.theme);
  const setTheme = useSettings((state) => state.setTheme);

  const models = useModels();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (open) void models.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1f1e1d]/35 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="flex h-[min(680px,90vh)] w-[min(860px,96vw)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <h2 className="text-[15px] font-semibold">{t("settings.title")}</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title={t("common.close")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* nav */}
          <nav className="w-44 shrink-0 border-r border-border p-3">
            <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
              {t("settings.general")}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-2">
                {t("settings.theme")}
              </span>
              <div className="flex overflow-hidden rounded-full border border-border bg-bg-0 p-0.5">
                {(["light", "dark"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    aria-pressed={theme === value}
                    className={`h-5 rounded-full px-2.5 text-[11px] font-semibold transition ${
                      theme === value
                        ? "bg-bg-invert text-txt-invert"
                        : "text-txt-2 hover:bg-bg-2 hover:text-txt-0"
                    }`}
                  >
                    {value === "light" ? t("settings.themeLight") : t("settings.themeDark")}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-2">
                {t("sidebar.language")}
              </span>
              <div className="flex overflow-hidden rounded-full border border-border bg-bg-0 p-0.5">
                {(["tr", "en"] as const).map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setLanguage(code)}
                    className={`h-5 rounded-full px-2.5 text-[11px] font-semibold uppercase transition ${
                      language === code ? "bg-bg-invert text-txt-invert" : "text-txt-2 hover:bg-bg-2"
                    }`}
                  >
                    {code}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 space-y-2.5 px-2">
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-[11.5px] text-txt-1" title={t("settings.sendOnEnterHint")}>
                  {t("settings.sendOnEnter")}
                </span>
                <input
                  type="checkbox"
                  checked={sendOnEnter}
                  onChange={(event) => setSendOnEnter(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-[11.5px] text-txt-1">{t("settings.showTimestamps")}</span>
                <input
                  type="checkbox"
                  checked={showTimestamps}
                  onChange={(event) => setShowTimestamps(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
              </label>
            </div>

            <div className="mt-4 px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
              {t("settings.data")}
            </div>
            <div className="px-2">
              <button
                type="button"
                onClick={() => void exportData()}
                className="w-full rounded-lg border border-border px-2.5 py-1.5 text-left text-[11.5px] text-txt-1 transition hover:bg-bg-2"
              >
                {exporting ? t("settings.exporting") : t("settings.exportData")}
              </button>
              <p className="pt-1 text-[10.5px] leading-relaxed text-txt-2">
                {t("settings.exportHint")}
              </p>
            </div>

            <div className="mt-4 px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
              {t("settings.about")}
            </div>
            <div className="px-2 text-[10.5px] leading-relaxed text-txt-2">
              <div>PolyLab v{coreVersion ?? "?"} · Electron {bridge()?.versions?.electron ?? "—"}</div>
              <div>{bridge()?.platform ?? "web"}</div>
            </div>


            <div className="mt-4 px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
              {t("settings.providers")}
            </div>
            <div className="mt-1 space-y-1">
              <Button
                variant={adding ? "primary" : "ghost"}
                size="sm"
                className="w-full justify-start"
                onClick={() => setAdding(true)}
              >
                <PlusSquareIcon className="h-4 w-4" />
                {t("settings.addProvider")}
              </Button>
            </div>
          </nav>

          {/* content */}
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {adding ? (
              <AddProviderForm onDone={() => setAdding(false)} />
            ) : models.providers.length === 0 ? (
              <EmptyProviders onAdd={() => setAdding(true)} />
            ) : (
              <div className="space-y-3">
                {models.providers.map((provider) => (
                  <ProviderCard key={provider.id} provider={provider} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyProviders({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-3 text-4xl" aria-hidden>🔌</div>
      <p className="max-w-sm text-[13.5px] leading-relaxed text-txt-1">
        {t("settings.emptyProviders")}
      </p>
      <Button variant="primary" size="sm" className="mt-4" onClick={onAdd}>
        {t("settings.addProvider")}
      </Button>
    </div>
  );
}

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const addProvider = useModels((state) => state.addProvider);
  const [kind, setKind] = useState<string>("openai");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindDef = PROVIDER_KINDS.find((entry) => entry.id === kind);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addProvider({
        kind,
        name: name.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-lg space-y-4">
      <div>
        <label className="mb-1.5 block text-[12.5px] font-medium text-txt-1">
          {t("settings.provider.kind")}
        </label>
        <div className="grid grid-cols-4 gap-1.5">
          {PROVIDER_KINDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setKind(entry.id);
                setBaseUrl("");
              }}
              className={`h-9 rounded-lg border text-[12px] font-medium capitalize transition ${
                kind === entry.id
                  ? "border-accent-2/60 bg-bg-3 text-txt-0"
                  : "border-border bg-bg-2 text-txt-2 hover:text-txt-1"
              }`}
            >
              {entry.id}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[12.5px] font-medium text-txt-1">
          {t("settings.provider.name")}
        </label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={kindDef?.id ?? ""}
          className="h-9 w-full rounded-lg border border-border bg-bg-2 px-3 text-[13px] text-txt-0 placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-[12.5px] font-medium text-txt-1">
          {t("settings.provider.baseUrl")}{" "}
          {kind !== "custom" && (
            <span className="font-normal text-txt-2">
              ({t("settings.provider.optionalDefault", { url: kindDef?.defaultBase })})
            </span>
          )}
        </label>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={kindDef?.defaultBase}
          className="h-9 w-full rounded-lg border border-border bg-bg-2 px-3 text-[13px] text-txt-0 placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-[12.5px] font-medium text-txt-1">
          {t("settings.provider.apiKey")}
        </label>
        <div className="relative">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={kindDef?.needsKey ? "sk-…" : t("settings.provider.apiKeyOptional")}
            className="h-9 w-full rounded-lg border border-border bg-bg-2 pl-3 pr-9 text-[13px] text-txt-0 placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
          />
          <EyeIcon className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-2" />
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-txt-2">
          {t("settings.provider.keyStorage")}
        </p>
      </div>

      {error != null && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="primary" size="sm" type="submit" disabled={busy}>
          {busy ? t("settings.provider.saving") : t("settings.provider.save")}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

function ProviderCard({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const localModels = useModels((state) =>
    state.models.filter((model) => model.provider_id === provider.id),
  );
  const test = useModels((state) => state.test);
  const removeProvider = useModels((state) => state.removeProvider);
  const setProviderKey = useModels((state) => state.setProviderKey);

  const [expanded, setExpanded] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [remote, setRemote] = useState<RemoteModel[] | null>(null);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadModels = async () => {
    setLoadingRemote(true);
    try {
      setRemote(await useModels.getState().fetchRemoteModels(provider.id));
    } catch {
      setRemote([]);
    } finally {
      setLoadingRemote(false);
    }
  };

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && remote == null) void loadModels();
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setTestResult(await test(provider.id));
    } catch (caught) {
      setTestResult({ ok: false, model_count: null, detail: String(caught) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-bg-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" onClick={toggleExpand} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-[11px] font-bold uppercase text-white">
            {provider.kind.slice(0, 2)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium text-txt-0">{provider.name}</span>
            <span className="block truncate text-[11.5px] text-txt-2">
              {provider.kind} · {provider.base_url ?? t("settings.provider.defaultUrl")}
              {provider.has_api_key ? ` · ${t("settings.provider.keyPresent")}` : ""}
            </span>
          </span>
        </button>

        <Button variant="ghost" size="sm" onClick={runTest} disabled={testing}>
          {testing ? "…" : t("settings.provider.test")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title={t("settings.provider.delete")}
          onClick={() => {
            if (confirmDelete) void removeProvider(provider.id);
            else setConfirmDelete(true);
          }}
          className={confirmDelete ? "text-danger" : ""}
        >
          {confirmDelete ? t("settings.provider.confirmDelete") : <TrashIcon className="h-4 w-4" />}
        </Button>
      </div>

      {testResult != null && (
        <div
          className={`mx-4 mb-3 rounded-lg px-3 py-2 text-[12.5px] ${
            testResult.ok
              ? "border border-success/40 bg-success/10 text-success"
              : "border border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          {testResult.ok
            ? t("settings.provider.testOk", { count: testResult.model_count ?? 0 })
            : t("settings.provider.testFail", { detail: testResult.detail ?? "" })}
        </div>
      )}

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {/* api key update */}
          <div className="mb-3 flex gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder={t("settings.provider.newKey")}
              className="h-8 flex-1 rounded-lg border border-border bg-bg-2 px-2.5 text-[12.5px] text-txt-0 placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
            />
            <Button
              variant="subtle"
              size="sm"
              disabled={keyDraft.trim().length === 0}
              onClick={async () => {
                await setProviderKey(provider.id, keyDraft.trim());
                setKeyDraft("");
              }}
            >
              {t("settings.provider.saveKey")}
            </Button>
          </div>

          {/* local model editor rows */}
          {localModels.length > 0 && (
            <div className="mb-4 space-y-1.5" data-testid="model-editor">
              <div className="px-0.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
                {t("settings.models")}
              </div>
              {localModels.map((model) => (
                <ModelEditorRow key={model.id} modelId={model.id} />
              ))}
            </div>
          )}

          {/* remote models */}
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-txt-2">
              {t("settings.provider.models")}
            </span>
            <button
              type="button"
              onClick={() => void loadModels()}
              className="flex h-6 w-6 items-center justify-center rounded-md text-txt-2 transition hover:bg-bg-3 hover:text-txt-0"
              title={t("settings.provider.reload")}
            >
              <RefreshIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          {loadingRemote ? (
            <div className="py-4 text-center text-[12.5px] text-txt-2">{t("common.loading")}</div>
          ) : remote != null && remote.length === 0 ? (
            <div className="py-3 text-center text-[12.5px] text-txt-2">
              {t("settings.provider.noModels")}
            </div>
          ) : (
            <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto">
              {remote?.map((model) => (
                <RemoteModelRow key={model.id} providerId={provider.id} model={model} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RemoteModelRow({ providerId, model }: { providerId: string; model: RemoteModel }) {
  const { t } = useTranslation();
  const addModel = useModels((state) => state.addModel);
  const removeModel = useModels((state) => state.removeModel);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      if (model.added) {
        const local = useModels.getState().models.find(
          (entry) => entry.provider_id === providerId && entry.model_id === model.id,
        );
        if (local != null) await removeModel(local.id);
      } else {
        await addModel(providerId, model.id);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void toggle()}
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] transition disabled:opacity-50 ${
        model.added
          ? "border-accent-2/50 bg-accent-2/10 text-txt-0"
          : "border-border bg-bg-2 text-txt-1 hover:text-txt-0"
      }`}
    >
      {model.added && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent-2" />}
      <span className="truncate">{model.id}</span>
      <span className="ml-auto shrink-0 text-[10.5px] text-txt-2">
        {model.added ? t("settings.provider.added") : t("settings.provider.add")}
      </span>
    </button>
  );
}

/* --------------------------------------------------------- model editor row */

const MODEL_COLORS = ["#c84040", "#3f8f5b", "#4263c8", "#8f3fc8", "#c77d1e", "#0f8f8f", "#83827d"];

function ModelEditorRow({ modelId }: { modelId: string }) {
  const { t } = useTranslation();
  const model = useModels((state) => state.models.find((entry) => entry.id === modelId));
  const patchModel = useModels((state) => state.patchModel);
  if (model == null) return null;
  return (
    <div className="rounded-lg border border-border bg-bg-2/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="flex gap-1">
          {MODEL_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              onClick={() => void patchModel(model.id, { color })}
              className={`h-3.5 w-3.5 rounded-full border transition ${
                (model.color ?? MODEL_COLORS[0]) === color ? "border-txt-0" : "border-transparent"
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </span>
        <input
          defaultValue={model.display_name}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value.length > 0 && value !== model.display_name) {
              void patchModel(model.id, { display_name: value });
            }
          }}
          className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[12.5px] text-txt-0 hover:border-border focus:border-txt-2/40 focus:outline-none"
        />
        <label className="flex items-center gap-1 text-[11px] text-txt-2">
          {t("settings.model.temperature")}
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            defaultValue={model.temperature ?? ""}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              void patchModel(model.id, {
                temperature: raw.length === 0 ? null : Number(raw),
              });
            }}
            className="h-6 w-12 rounded-md border border-border bg-bg-0 px-1 text-[11px] tabular-nums text-txt-0"
          />
        </label>
        <label className="flex items-center gap-1 text-[11px] text-txt-2">
          {t("settings.model.maxTokens")}
          <input
            type="number"
            min={128}
            step={128}
            defaultValue={model.max_tokens ?? ""}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              void patchModel(model.id, { max_tokens: raw.length === 0 ? null : Number(raw) });
            }}
            className="h-6 w-16 rounded-md border border-border bg-bg-0 px-1 text-[11px] tabular-nums text-txt-0"
          />
        </label>
      </div>
    </div>
  );
}
