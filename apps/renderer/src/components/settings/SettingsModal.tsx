import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  addProviderKey,
  createProvider,
  deleteProviderKey,
  getConversation,
  listConversations,
  listProviderKeys,
  updateProviderKey,
  type Provider,
  type ProviderKeySummary,
  type RemoteModel,
  type TestResult,
} from "../../lib/api";
import { bridge } from "../../lib/backend";
import { useConnection } from "../../stores/connection";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { Button } from "../ui/Button";
import {
  CheckIcon,
  CloseIcon,
  EyeIcon,
  GearIcon,
  PlusIcon,
  PlusSquareIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
} from "../ui/Icons";

const PROVIDER_KINDS = [
  { id: "openai", base: "https://api.openai.com/v1", key: true },
  { id: "anthropic", base: "https://api.anthropic.com", key: true },
  { id: "gemini", base: "https://generativelanguage.googleapis.com", key: true },
  { id: "openrouter", base: "https://openrouter.ai/api/v1", key: true },
  { id: "deepseek", base: "https://api.deepseek.com/v1", key: true },
  { id: "groq", base: "https://api.groq.com/openai/v1", key: true },
  { id: "mistral", base: "https://api.mistral.ai/v1", key: true },
  { id: "xai", base: "https://api.x.ai/v1", key: true },
  { id: "lmstudio", base: "http://localhost:1234/v1", key: false },
  { id: "ollama", base: "http://localhost:11434", key: false },
  { id: "custom", base: "", key: false },
] as const;

type Section = "general" | "providers" | "groups";

export function SettingsModal() {
  const { t } = useTranslation();
  const open = useSettings((state) => state.settingsOpen);
  const setOpen = useSettings((state) => state.setSettingsOpen);
  const language = useSettings((state) => state.language);
  const setLanguage = useSettings((state) => state.setLanguage);
  const theme = useSettings((state) => state.theme);
  const setTheme = useSettings((state) => state.setTheme);
  const refreshModels = useModels((state) => state.refresh);
  const providerCount = useModels((state) => state.providers.length);
  const modelCount = useModels((state) => state.models.length);
  const groupCount = useModels((state) => state.groups.length);
  const [section, setSection] = useState<Section>("providers");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (open) void refreshModels();
  }, [open, refreshModels]);

  if (!open) return null;

  const sectionTitle =
    section === "general"
      ? t("settings.nav.general")
      : section === "providers"
        ? t("settings.nav.providers")
        : t("settings.nav.groups");
  const sectionSubtitle =
    section === "general"
      ? t("settings.generalSubtitle")
      : section === "providers"
        ? t("settings.providersSubtitle")
        : t("settings.groupsSubtitle");

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="flex h-[min(760px,94vh)] w-[min(1020px,96vw)] overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]">
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-bg-1/70 p-3">
          <div className="px-2 pb-4 pt-2">
            <div className="text-[15px] font-semibold text-txt-0">{t("settings.title")}</div>
            <div className="mt-1 text-[11.5px] text-txt-2">{t("settings.subtitle")}</div>
          </div>
          <SettingsNavButton active={section === "general"} onClick={() => setSection("general")}>
            {t("settings.nav.general")}
          </SettingsNavButton>
          <SettingsNavButton active={section === "providers"} onClick={() => setSection("providers")}>
            {t("settings.nav.providers")}
          </SettingsNavButton>
          <SettingsNavButton active={section === "groups"} onClick={() => setSection("groups")}>
            {t("settings.nav.groups")}
          </SettingsNavButton>
          <div className="mt-auto border-t border-border pt-3">
            <div className="px-2 text-[10.5px] font-semibold uppercase tracking-wider text-txt-2">
              {t("settings.workspace")}
            </div>
            <div className="mt-2 rounded-lg border border-border bg-bg-0 px-2.5 py-2 text-[11.5px] text-txt-2">
              {t("settings.workspaceSummary", {
                providers: providerCount,
                models: modelCount,
                groups: groupCount,
              })}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
            <div>
              <div className="text-[14px] font-semibold text-txt-0">{sectionTitle}</div>
              <div className="text-[11px] text-txt-2">{sectionSubtitle}</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title={t("common.close")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 hover:bg-bg-2 hover:text-txt-0"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === "general" && (
              <GeneralSection
                language={language}
                setLanguage={setLanguage}
                theme={theme}
                setTheme={setTheme}
              />
            )}
            {section === "providers" &&
              (adding ? (
                <AddProviderForm onDone={() => setAdding(false)} />
              ) : (
                <ProvidersSection onAdd={() => setAdding(true)} />
              ))}
            {section === "groups" && <GroupsSection />}
          </div>
        </main>
      </div>
    </div>
  );
}

function SettingsNavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 flex h-9 w-full items-center rounded-lg px-2.5 text-left text-[12.5px] transition ${
        active ? "bg-bg-3 font-medium text-txt-0" : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
      }`}
    >
      {children}
    </button>
  );
}

function GeneralSection({
  language,
  setLanguage,
  theme,
  setTheme,
}: {
  language: "tr" | "en";
  setLanguage: (value: "tr" | "en") => void;
  theme: "light" | "dark";
  setTheme: (value: "light" | "dark") => void;
}) {
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
      const payload: unknown[] = [];
      for (const conversation of conversations) {
        const detail = await getConversation(conversation.id);
        payload.push({ ...conversation, messages: detail.messages });
      }
      const blob = new Blob(
        [JSON.stringify({ exported_at: new Date().toISOString(), conversations: payload }, null, 2)],
        { type: "application/json" },
      );
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

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SettingCard title={t("settings.theme")} description={t("settings.themeDesc")}>
        <SettingRow label={t("settings.themeLabel")} description={t("settings.themeRowDesc")}>
          <div className="flex rounded-lg border border-border bg-bg-2 p-1">
            {(["light", "dark"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={`rounded-md px-3 py-1.5 text-[12px] capitalize ${
                  theme === value ? "bg-bg-invert text-txt-invert" : "text-txt-2 hover:text-txt-0"
                }`}
              >
                {value === "light" ? t("settings.themeLight") : t("settings.themeDark")}
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingCard>

      <SettingCard title={t("settings.language")} description={t("settings.languageDesc")}>
        <SettingRow label={t("settings.languageLabel")} description={t("settings.languageRowDesc")}>
          <div className="flex rounded-lg border border-border bg-bg-2 p-1">
            {(["tr", "en"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setLanguage(value)}
                className={`rounded-md px-3 py-1.5 text-[12px] uppercase ${
                  language === value ? "bg-bg-invert text-txt-invert" : "text-txt-2 hover:text-txt-0"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingCard>

      <SettingCard title={t("settings.composer")} description={t("settings.composerDesc")}>
        <div className="space-y-2">
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
      </SettingCard>

      <SettingCard title={t("settings.fallbackTitle")} description={t("settings.fallbackDesc")}>
        <div className="space-y-2 text-[12.5px] leading-relaxed text-txt-1">
          <div className="rounded-lg border border-border bg-bg-2 px-3 py-2">{t("settings.fallbackPoint1")}</div>
          <div className="rounded-lg border border-border bg-bg-2 px-3 py-2">{t("settings.fallbackPoint2")}</div>
          <div className="rounded-lg border border-border bg-bg-2 px-3 py-2">{t("settings.fallbackPoint3")}</div>
        </div>
      </SettingCard>

      <SettingCard title={t("settings.data")} description={t("settings.dataDesc")}>
        <button
          type="button"
          onClick={() => void exportData()}
          className="w-full rounded-lg border border-border px-2.5 py-1.5 text-left text-[11.5px] text-txt-1 transition hover:bg-bg-2"
        >
          {exporting ? t("settings.exporting") : t("settings.exportData")}
        </button>
        <p className="pt-1 text-[10.5px] leading-relaxed text-txt-2">{t("settings.exportHint")}</p>
      </SettingCard>

      <SettingCard title={t("settings.about")} description={t("settings.aboutDesc")}>
        <div className="space-y-1 text-[11.5px] leading-relaxed text-txt-2">
          <div>
            {t("settings.aboutVersion", { version: coreVersion ?? "?" })}
            {bridge()?.versions?.electron != null &&
              ` · ${t("settings.aboutElectron", { version: bridge()?.versions?.electron })}`}
          </div>
          <div>{bridge()?.platform ?? t("settings.aboutWeb")}</div>
        </div>
      </SettingCard>
    </div>
  );
}

function ProvidersSection({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  const providers = useModels((state) => state.providers);
  const models = useModels((state) => state.models);
  const [selectedId, setSelectedId] = useState<string | null>(providers[0]?.id ?? null);
  useEffect(() => {
    if (selectedId == null && providers[0] != null) setSelectedId(providers[0].id);
    if (selectedId != null && !providers.some((provider) => provider.id === selectedId))
      setSelectedId(providers[0]?.id ?? null);
  }, [providers, selectedId]);
  const selected = providers.find((provider) => provider.id === selectedId) ?? null;
  return (
    <div className="grid min-h-[590px] grid-cols-[270px_minmax(0,1fr)] gap-4">
      <div className="flex min-h-0 flex-col rounded-xl border border-border bg-bg-1 p-2">
        <div className="flex items-center justify-between px-2 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-2">
            {t("settings.connections")}
          </span>
          <button
            type="button"
            onClick={onAdd}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-accent hover:bg-bg-2"
            title={t("settings.addProvider")}
          >
            <PlusSquareIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {providers.map((provider) => {
            const count = models.filter((model) => model.provider_id === provider.id).length;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setSelectedId(provider.id)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                  selectedId === provider.id ? "border-border bg-bg-3" : "border-transparent hover:bg-bg-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-[10px] font-bold uppercase text-white">
                    {provider.kind.slice(0, 2)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-txt-0">{provider.name}</span>
                    <span className="block truncate text-[10.5px] text-txt-2">
                      {t("settings.providerSummary", {
                        models: count,
                        keys: provider.api_key_count ?? (provider.has_api_key ? 1 : 0),
                      })}
                    </span>
                  </span>
                  <span className={`h-2 w-2 rounded-full ${provider.enabled ? "bg-success" : "bg-txt-2"}`} />
                </div>
              </button>
            );
          })}
          {providers.length === 0 && (
            <div className="px-3 py-8 text-center text-[12.5px] text-txt-2">{t("settings.noProviders")}</div>
          )}
        </div>
      </div>
      {selected != null ? <ProviderDetails provider={selected} /> : <EmptyProviders onAdd={onAdd} />}
    </div>
  );
}

function ProviderDetails({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const fetchRemoteModels = useModels((state) => state.fetchRemoteModels);
  const refreshModels = useModels((state) => state.refresh);
  const removeProvider = useModels((state) => state.removeProvider);
  const localModels = useModels((state) => state.models.filter((model) => model.provider_id === provider.id));
  const test = useModels((state) => state.test);
  const addModel = useModels((state) => state.addModel);
  const removeModel = useModels((state) => state.removeModel);
  const patchModel = useModels((state) => state.patchModel);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [keys, setKeys] = useState<ProviderKeySummary[]>([]);
  const [remote, setRemote] = useState<RemoteModel[] | null>(null);
  const [remoteQuery, setRemoteQuery] = useState("");
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadKeys = async () => {
    try {
      setKeys(await listProviderKeys(provider.id));
    } catch {
      setKeys([]);
    }
  };
  const loadRemote = async () => {
    setLoadingRemote(true);
    try {
      setRemote(await fetchRemoteModels(provider.id));
    } catch {
      setRemote([]);
    } finally {
      setLoadingRemote(false);
    }
  };
  useEffect(() => {
    setTestResult(null);
    setShowKeys(false);
    setRemoteQuery("");
    void loadKeys();
    void loadRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  const filteredRemote = useMemo(() => {
    const needle = remoteQuery.trim().toLowerCase();
    return (remote ?? []).filter(
      (model) => needle.length === 0 || `${model.id} ${model.display_name}`.toLowerCase().includes(needle),
    );
  }, [remote, remoteQuery]);

  const runTest = async () => {
    setTesting(true);
    try {
      setTestResult(await test(provider.id));
    } catch (error) {
      setTestResult({ ok: false, model_count: null, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-xl border border-border bg-bg-1 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-xs font-bold uppercase text-white">
              {provider.kind.slice(0, 2)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-txt-0">{provider.name}</div>
              <div className="truncate text-[11.5px] text-txt-2">
                {provider.base_url ?? t("settings.provider.defaultEndpoint")}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="subtle" size="sm" onClick={runTest} disabled={testing}>
              {testing ? t("settings.provider.testing") : t("settings.provider.test")}
            </Button>
            <button
              type="button"
              onClick={() => {
                const next = !showKeys;
                setShowKeys(next);
                if (next) void loadKeys();
              }}
              title={t("settings.provider.apiKeysTitle")}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border border-border ${
                showKeys ? "bg-bg-3 text-txt-0" : "text-txt-2 hover:bg-bg-2 hover:text-txt-0"
              }`}
            >
              <GearIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirmDelete) void removeProvider(provider.id);
                else setConfirmDelete(true);
              }}
              className={`flex h-8 items-center rounded-lg border border-border px-2 text-[11px] ${
                confirmDelete ? "text-danger" : "text-txt-2 hover:text-danger"
              }`}
            >
              {confirmDelete ? t("settings.provider.confirmDelete") : <TrashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {testResult != null && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-[12px] ${
              testResult.ok
                ? "border-success/40 bg-success/10 text-success"
                : "border-danger/40 bg-danger/10 text-danger"
            }`}
          >
            {testResult.ok
              ? t("settings.provider.testOk", { count: testResult.model_count ?? 0 })
              : t("settings.provider.testFail", { detail: testResult.detail ?? t("settings.provider.unknownError") })}
          </div>
        )}
        {showKeys && <ApiKeysPanel provider={provider} keys={keys} setKeys={setKeys} refreshModels={refreshModels} />}
      </section>

      <section className="rounded-xl border border-border bg-bg-1 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[12.5px] font-semibold text-txt-0">{t("settings.configuredModels")}</div>
            <div className="text-[11px] text-txt-2">{t("settings.configuredModelsDesc")}</div>
          </div>
          <span className="rounded-full border border-border bg-bg-2 px-2 py-1 text-[10.5px] text-txt-2">
            {localModels.length}
          </span>
        </div>
        <div className="space-y-1.5">
          {localModels.map((model) => (
            <ModelEditorRow key={model.id} modelId={model.id} patchModel={patchModel} />
          ))}
          {localModels.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[12px] text-txt-2">
              {t("settings.noConfiguredModels")}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-bg-1 p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold text-txt-0">{t("settings.modelCatalog")}</div>
            <div className="text-[11px] text-txt-2">{t("settings.modelCatalogDesc")}</div>
          </div>
          <button
            type="button"
            onClick={() => void loadRemote()}
            title={t("settings.refreshCatalog")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 hover:bg-bg-2 hover:text-txt-0"
          >
            <RefreshIcon className={`h-4 w-4 ${loadingRemote ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="relative mb-3">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-2" />
          <input
            value={remoteQuery}
            onChange={(event) => setRemoteQuery(event.target.value)}
            placeholder={t("settings.searchModels")}
            className="h-9 w-full rounded-lg border border-border bg-bg-2 pl-9 pr-3 text-[12.5px] text-txt-0 outline-none placeholder:text-txt-2 focus:border-accent/50"
          />
        </div>
        {loadingRemote && <div className="py-6 text-center text-[12px] text-txt-2">{t("settings.loadingCatalog")}</div>}
        {!loadingRemote && remote != null && remote.length === 0 && (
          <div className="py-6 text-center text-[12px] text-txt-2">{t("settings.noCatalogModels")}</div>
        )}
        {!loadingRemote && remote != null && remote.length > 0 && filteredRemote.length === 0 && (
          <div className="py-6 text-center text-[12px] text-txt-2">{t("settings.noMatchingModels")}</div>
        )}
        {!loadingRemote && filteredRemote.length > 0 && (
          <div className="grid max-h-72 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {filteredRemote.map((model) => (
              <CatalogModelRow
                key={model.id}
                providerId={provider.id}
                model={model}
                localModels={localModels}
                addModel={addModel}
                removeModel={removeModel}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ApiKeysPanel({
  provider,
  keys,
  setKeys,
  refreshModels,
}: {
  provider: Provider;
  keys: ProviderKeySummary[];
  setKeys: (keys: ProviderKeySummary[]) => void;
  refreshModels: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState<number | "add" | null>(null);
  return (
    <div className="mt-4 rounded-xl border border-border bg-bg-0 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-[12px] font-semibold text-txt-0">{t("settings.apiKeys")}</div>
          <div className="text-[10.5px] text-txt-2">{t("settings.apiKeysHint")}</div>
        </div>
        <span className="text-[10.5px] tabular-nums text-txt-2">
          {t("settings.keysConfigured", { count: keys.length })}
        </span>
      </div>
      <div className="space-y-1.5">
        {keys.map((key) => (
          <div
            key={key.index}
            className="flex items-center gap-2 rounded-lg border border-border bg-bg-2 px-2.5 py-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 rounded-md bg-bg-3 px-1.5 py-1 text-[10px] font-semibold uppercase text-txt-2">
                {key.primary ? t("settings.keyPrimary") : t("settings.keyFallback", { index: key.index + 1 })}
              </span>
              <code className="truncate text-[11.5px] text-txt-1">{key.prefix}</code>
            </div>
            {drafts[key.index] != null ? (
              <>
                <input
                  type="password"
                  value={drafts[key.index]}
                  onChange={(event) => setDrafts({ ...drafts, [key.index]: event.target.value })}
                  placeholder={t("settings.newKey")}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg-0 px-2 text-[11.5px] text-txt-0 outline-none"
                />
                <Button
                  variant="subtle"
                  size="sm"
                  disabled={busy === key.index || drafts[key.index].trim().length === 0}
                  onClick={async () => {
                    setBusy(key.index);
                    try {
                      setKeys(await updateProviderKey(provider.id, key.index, drafts[key.index].trim()));
                      const next = { ...drafts };
                      delete next[key.index];
                      setDrafts(next);
                      await refreshModels();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {t("common.save")}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...drafts };
                    delete next[key.index];
                    setDrafts(next);
                  }}
                  className="text-[11px] text-txt-2 hover:text-txt-0"
                >
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setDrafts({ ...drafts, [key.index]: "" })}
                className="text-[11px] text-accent-2 hover:text-accent"
              >
                {t("common.change")}
              </button>
            )}
            <button
              type="button"
              disabled={busy === key.index}
              onClick={async () => {
                setBusy(key.index);
                try {
                  setKeys(await deleteProviderKey(provider.id, key.index));
                  await refreshModels();
                } finally {
                  setBusy(null);
                }
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-txt-2 hover:bg-danger/10 hover:text-danger"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {keys.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[11.5px] text-txt-2">
            {t("settings.noKeys")}
          </div>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <EyeIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-txt-2" />
          <input
            type="password"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            placeholder={t("settings.addFallbackPlaceholder")}
            className="h-8 w-full rounded-lg border border-border bg-bg-2 pl-2.5 pr-8 text-[11.5px] text-txt-0 outline-none placeholder:text-txt-2"
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={busy === "add" || adding.trim().length === 0}
          onClick={async () => {
            setBusy("add");
            try {
              setKeys(await addProviderKey(provider.id, adding.trim()));
              setAdding("");
              await refreshModels();
            } finally {
              setBusy(null);
            }
          }}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          {t("settings.addFallback")}
        </Button>
      </div>
      <div className="mt-2 text-[10.5px] leading-relaxed text-txt-2">{t("settings.fallbackNote")}</div>
    </div>
  );
}

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const refreshModels = useModels((state) => state.refresh);
  const [kind, setKind] = useState("openai");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const def = PROVIDER_KINDS.find((entry) => entry.id === kind) ?? PROVIDER_KINDS[0];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createProvider({
        kind,
        name: name.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
      });
      await refreshModels();
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-5">
      <div className="rounded-xl border border-border bg-bg-1 p-4">
        <div className="mb-3 text-[13px] font-semibold text-txt-0">{t("settings.addProvider")}</div>
        <div className="grid gap-2 sm:grid-cols-4">
          {PROVIDER_KINDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setKind(entry.id);
                setBaseUrl("");
              }}
              className={`rounded-lg border px-2 py-2 text-[11.5px] capitalize transition ${
                kind === entry.id
                  ? "border-accent/50 bg-accent/10 text-txt-0"
                  : "border-border bg-bg-2 text-txt-2 hover:text-txt-0"
              }`}
            >
              {entry.id}
            </button>
          ))}
        </div>
      </div>
      <SettingCard title={t("settings.connection")} description={t("settings.connectionDesc")}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t("settings.provider.name")}>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={def.id} className="input-base" />
          </Field>
          <Field label={t("settings.provider.baseUrl")}>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={def.base} className="input-base" />
          </Field>
          <Field label={t("settings.primaryKey")} className="md:col-span-2">
            <div className="relative">
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={def.key ? t("settings.pasteKey") : t("settings.notRequired")}
                className="input-base pr-9"
              />
              <EyeIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-2" />
            </div>
          </Field>
        </div>
      </SettingCard>
      {error != null && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
      )}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" type="submit" disabled={busy}>
          {busy ? t("common.saving") : t("settings.addProvider")}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

function EmptyProviders({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-bg-1 p-10">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-bg-3 text-txt-1">
          <PlusSquareIcon className="h-5 w-5" />
        </div>
        <div className="text-[13px] font-semibold text-txt-0">{t("settings.noProviderConnected")}</div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-txt-2">{t("settings.noProviderConnectedDesc")}</p>
        <Button variant="primary" size="sm" className="mt-4" onClick={onAdd}>
          {t("settings.addProvider")}
        </Button>
      </div>
    </div>
  );
}

function CatalogModelRow({
  providerId,
  model,
  localModels,
  addModel,
  removeModel,
}: {
  providerId: string;
  model: RemoteModel;
  localModels: ReturnType<typeof useModels.getState>["models"];
  addModel: (providerId: string, modelId: string) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const local = localModels.find((entry) => entry.model_id === model.id);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          if (local != null) await removeModel(local.id);
          else await addModel(providerId, model.id);
        } finally {
          setBusy(false);
        }
      }}
      className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition disabled:opacity-50 ${
        local != null ? "border-accent/40 bg-accent/10" : "border-border bg-bg-2 hover:bg-bg-3"
      }`}
    >
      {local != null ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" /> : <PlusIcon className="h-3.5 w-3.5 shrink-0 text-txt-2" />}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-txt-1">{model.display_name || model.id}</span>
      <span className="shrink-0 text-[9.5px] uppercase text-txt-2">
        {local != null ? t("settings.catalog.added") : t("settings.catalog.add")}
      </span>
    </button>
  );
}

function ModelEditorRow({
  modelId,
  patchModel,
}: {
  modelId: string;
  patchModel: ReturnType<typeof useModels.getState>["patchModel"];
}) {
  const { t } = useTranslation();
  const model = useModels((state) => state.models.find((entry) => entry.id === modelId));
  if (model == null) return null;
  return (
    <div className="rounded-lg border border-border bg-bg-2/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          defaultValue={model.display_name}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value && value !== model.display_name) void patchModel(model.id, { display_name: value });
          }}
          className="h-8 min-w-[160px] flex-1 rounded-lg border border-border bg-bg-0 px-2.5 text-[11.5px] text-txt-0 outline-none"
        />
        <label className="flex items-center gap-1.5 text-[10.5px] text-txt-2">
          {t("settings.model.temperature")}
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            defaultValue={model.temperature ?? ""}
            onBlur={(event) =>
              void patchModel(model.id, {
                temperature: event.target.value.trim() ? Number(event.target.value) : null,
              })
            }
            className="h-8 w-16 rounded-lg border border-border bg-bg-0 px-2 text-[11px] text-txt-0"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[10.5px] text-txt-2">
          {t("settings.model.maxTokens")}
          <input
            type="number"
            min={128}
            step={128}
            defaultValue={model.max_tokens ?? ""}
            onBlur={(event) =>
              void patchModel(model.id, {
                max_tokens: event.target.value.trim() ? Number(event.target.value) : null,
              })
            }
            className="h-8 w-20 rounded-lg border border-border bg-bg-0 px-2 text-[11px] text-txt-0"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[10.5px] text-txt-2">
          <input
            type="checkbox"
            defaultChecked={model.enabled}
            onChange={(event) => void patchModel(model.id, { enabled: event.target.checked })}
          />
          {t("settings.enabled")}
        </label>
      </div>
      <div className="mt-1 truncate text-[9.5px] text-txt-2">{model.model_id}</div>
    </div>
  );
}

function GroupsSection() {
  const { t } = useTranslation();
  const models = useModels((state) => state.models);
  const groups = useModels((state) => state.groups);
  const addGroup = useModels((state) => state.addGroup);
  const removeGroup = useModels((state) => state.removeGroup);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  const create = async () => {
    if (!name.trim() || selected.length < 2) return;
    setBusy(true);
    try {
      await addGroup({ name: name.trim(), model_ids: selected });
      setName("");
      setSelected([]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
      <SettingCard title={t("settings.groups.createTitle")} description={t("settings.groups.createDesc")}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("settings.groups.namePlaceholder")}
          className="input-base"
        />
        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
          {models
            .filter((model) => model.enabled)
            .map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => toggle(model.id)}
                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left ${
                  selected.includes(model.id) ? "border-accent/40 bg-accent/10" : "border-border bg-bg-2 hover:bg-bg-3"
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded border ${
                    selected.includes(model.id) ? "border-accent bg-accent text-white" : "border-txt-2"
                  }`}
                >
                  {selected.includes(model.id) && <CheckIcon className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-txt-1">{model.display_name}</span>
                <span className="truncate text-[9.5px] text-txt-2">{model.provider_name}</span>
              </button>
            ))}
        </div>
        <Button
          variant="primary"
          size="sm"
          className="mt-3"
          disabled={busy || !name.trim() || selected.length < 2}
          onClick={() => void create()}
        >
          {busy ? t("settings.groups.creating") : t("settings.groups.create")}
        </Button>
        <span className="ml-2 text-[10.5px] text-txt-2">
          {t("settings.groups.selectedCount", { count: selected.length })}
        </span>
      </SettingCard>
      <SettingCard title={t("settings.groups.existingTitle")} description={t("settings.groups.existingDesc")}>
        <div className="space-y-1.5">
          {groups.map((group) => (
            <div key={group.id} className="flex items-center gap-2 rounded-lg border border-border bg-bg-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-txt-0">{group.name}</div>
                <div className="truncate text-[10.5px] text-txt-2">
                  {group.models.map((model) => model.display_name).join(" · ")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void removeGroup(group.id)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-txt-2 hover:bg-danger/10 hover:text-danger"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {groups.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[11.5px] text-txt-2">
              {t("settings.groups.noGroups")}
            </div>
          )}
        </div>
      </SettingCard>
    </div>
  );
}

function SettingCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-bg-1 p-4">
      <div className="mb-4">
        <div className="text-[13px] font-semibold text-txt-0">{title}</div>
        <div className="mt-1 text-[11.5px] leading-relaxed text-txt-2">{description}</div>
      </div>
      {children}
    </section>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-bg-2 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[11.5px] font-medium text-txt-1">{label}</div>
        <div className="text-[10.5px] text-txt-2">{description}</div>
      </div>
      {children}
    </div>
  );
}

function Field({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[11px] font-medium text-txt-1">{label}</span>
      {children}
    </label>
  );
}
