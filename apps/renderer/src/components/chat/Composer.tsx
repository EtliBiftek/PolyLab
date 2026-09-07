import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { transcribeAudio, type Conversation } from "../../lib/api";
import { addProviderKey, createProvider, listProviderKeys, listProviders } from "../../lib/api";
import { useChat } from "../../stores/chat";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { ModelPicker, thinkEnabled } from "../models/ModelPicker";
import { ArrowUpIcon, GlobeIcon, MicIcon, PaperclipIcon, SparkIcon, SquareIcon } from "../ui/Icons";
import { ThinkEffortMenu, thinkLevels } from "./ThinkEffortMenu";

export function Composer() {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<
    Array<{ name: string; text?: string; mime_type?: string; data_base64?: string }>
  >([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // --- voice input ----------------------------------------------------
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [keyPrompt, setKeyPrompt] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const setFallbackModel = useChat((state) => state.setFallbackModel);

  // Suggestion chips (empty state) fill the composer.
  useEffect(() => {
    const onSuggest = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setValue(detail);
      textareaRef.current?.focus();
    };
    window.addEventListener("polylab:suggest", onSuggest);
    return () => window.removeEventListener("polylab:suggest", onSuggest);
  }, []);

  const readFile = (file: File): Promise<{ name: string; text?: string; mime_type?: string; data_base64?: string } | null> =>
    file.type.startsWith("image/")
      ? new Promise((resolve) => {
          if (file.size > 2 * 1024 * 1024) return resolve(null); // images ≤ 2 MB
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name,
              mime_type: file.type,
              data_base64: String(reader.result).split(",")[1] ?? "",
            });
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        })
      : file
          .text()
          .then((text) => (file.size > 512 * 1024 ? null : { name: file.name, text }))
          .catch(() => null);

  const addFiles = async (files: FileList | null) => {
    if (files == null) return;
    const next: Array<{ name: string; text?: string; mime_type?: string; data_base64?: string }> = [];
    for (const file of Array.from(files).slice(0, 5)) {
      const parsed = await readFile(file);
      if (parsed != null) next.push(parsed);
    }
    setAttachments((current) => [...current, ...next].slice(0, 5));
  };
  const sending = useChat((state) => state.sending);
  const send = useChat((state) => state.send);
  const cancel = useChat((state) => state.cancel);

  // --- Think + Web toggles next to the model picker -----------------------
  const models = useModels((state) => state.models);
  const setThink = useModels((state) => state.setThink);
  const sendOnEnter = useSettings((state) => state.sendOnEnter);
  const webSearch = useSettings((state) => state.webSearch);
  const setWebSearch = useSettings((state) => state.setWebSearch);
  const activeConversation = useChat((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId),
  );
  const lastModelId = useSettings((state) => state.lastModelId);
  const isGroupMode = activeConversation?.selection_type === "group";
  const selectedModel = models.find(
    (model) => model.id === (activeConversation?.model_id ?? useSettings.getState().lastModelId),
  );
  const thinkOn = selectedModel != null && thinkEnabled(selectedModel);
  // Web search is engine-side DuckDuckGo (all providers, all modes) — the
  // engine searches and injects the results into the prompt.
  const webCapable = true;

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (text.length === 0 || sending) return;
    void send(text, attachments.length > 0 ? attachments : undefined);
    setValue("");
    setAttachments([]);
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  };

  // Enter sends (when enabled); Shift+Enter always inserts a newline.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (!sendOnEnter) return;
      event.preventDefault();
      submit();
    }
  };

  const startRecording = async () => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        void (async () => {
          setTranscribing(true);
          try {
            const base64 = await blobToBase64(blob);
            const result = await transcribeAudio(base64, blob.type || "audio/webm");
            const text = result.text.trim();
            if (text.length > 0) setValue((current) => (current.length > 0 ? `${current} ${text}` : text));
          } catch (error) {
            setVoiceError(t("voice.transcribeError"));
            // A missing provider/key is fixable in-place.
            if (error instanceof Error && /anahtar|openai|key/i.test(error.message)) {
              setKeyPrompt(true);
            }
          } finally {
            setTranscribing(false);
          }
        })();
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setVoiceError(t("voice.transcribeError"));
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  const saveVoiceKey = async () => {
    const key = keyValue.trim();
    if (key.length === 0) {
      setVoiceError(t("voice.keyInvalid"));
      return;
    }
    setSavingKey(true);
    try {
      let provider = (await listProviders()).find((entry) => entry.kind === "openai");
      if (provider == null) provider = await createProvider({ kind: "openai" });
      const keys = await listProviderKeys(provider.id);
      if (keys.length === 0) await addProviderKey(provider.id, key);
      setKeyPrompt(false);
      setKeyValue("");
      setVoiceError(null);
    } catch {
      setVoiceError(t("voice.keyInvalid"));
    } finally {
      setSavingKey(false);
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      {/* claude.ai composer: gray card, hairline border, soft shadow. Bottom bar
          carries the model picker (with per-model think) and the send button. */}
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface p-2.5 shadow-[var(--shadow-card)] transition focus-within:border-txt-2/40">
        {attachments.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5 px-1">
            {attachments.map((attachment, index) => (
              <span
                key={`${attachment.name}-${index}`}
                className="flex items-center gap-1 rounded-full border border-border bg-bg-0 px-2 py-0.5 text-[11px] text-txt-1"
              >
                {attachment.data_base64 != null ? "🖼" : "📎"} {attachment.name}
                <button
                  type="button"
                  aria-label={t("common.remove")}
                  onClick={() =>
                    setAttachments((current) => current.filter((_, i) => i !== index))
                  }
                  className="text-txt-2 transition hover:text-danger"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={sending}
          onInput={autoGrow}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("chat.composerPlaceholder")}
          className="max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-1.5 pb-1 pt-1 text-[15px] leading-relaxed
            text-txt-0 placeholder:text-txt-2 focus:outline-none disabled:opacity-60"
        />

        <div className="mt-1 flex items-center gap-1">
          <ModelPicker />

          <button
            type="button"
            onClick={() => selectedModel != null && void setThink(selectedModel.id, !thinkOn)}
            disabled={selectedModel == null || isGroupMode}
            aria-pressed={thinkOn}
            title={
              selectedModel == null
                ? t("chat.think.pickModel")
                : thinkOn
                  ? t("chat.think.onHint", { name: selectedModel.display_name })
                  : t("chat.think.offHint", { name: selectedModel.display_name })
            }
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${
              thinkOn ? "text-accent hover:bg-accent/10" : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
            }`}
          >
            <SparkIcon className="h-4 w-4" />
          </button>
          {thinkOn && !isGroupMode && selectedModel != null && thinkLevels(selectedModel).length > 0 && (
            <ThinkEffortMenu model={selectedModel} />
          )}
          <button
            type="button"
            onClick={() => setWebSearch(!webSearch)}
            disabled={!webCapable}
            aria-pressed={webSearch}
            title={webCapable ? t("chat.web.hint") : t("chat.web.unsupported")}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:cursor-not-allowed ${
              webSearch && webCapable
                ? "text-accent hover:bg-accent/10"
                : "text-txt-2 hover:bg-bg-2 hover:text-txt-1 disabled:opacity-40"
            }`}
          >
            <GlobeIcon className="h-4 w-4" />
          </button>

          <div className="flex-1" />

          {/* Fallback model: used when the primary provider fails (single chat). */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setFallbackOpen((current) => !current)}
              disabled={isGroupMode}
              title={t("chat.fallbackPick")}
              aria-label={t("chat.fallbackPick")}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${
                activeConversation?.fallback_model_id != null
                  ? "text-accent hover:bg-accent/10"
                  : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
              }`}
            >
              ⇄
            </button>
            {fallbackOpen && (
              <div className="absolute bottom-10 right-0 z-50 w-64 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
                <div className="px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-txt-2">
                  {t("chat.fallbackLabel")}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void setFallbackModel(null);
                    setFallbackOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition hover:bg-bg-2 ${
                    activeConversation?.fallback_model_id == null ? "text-txt-0" : "text-txt-1"
                  }`}
                >
                  {t("chat.fallbackNone")}
                </button>
                <div className="my-1 border-t border-border" />
                {models
                  .filter((model) => model.enabled && model.id !== (activeConversation?.model_id ?? lastModelId))
                  .map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        void setFallbackModel(model.id);
                        setFallbackOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition hover:bg-bg-2 ${
                        activeConversation?.fallback_model_id === model.id ? "text-accent" : "text-txt-1"
                      }`}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: model.color ?? "var(--txt-2)" }} />
                      <span className="truncate">{model.display_name}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              if (recording) stopRecording();
              else void startRecording();
            }}
            disabled={transcribing || sending}
            title={recording ? t("voice.stopRecord") : t("voice.record")}
            aria-label={recording ? t("voice.stopRecord") : t("voice.record")}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:opacity-50 ${
              recording ? "bg-danger/15 text-danger" : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
            }`}
          >
            <MicIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title={t("chat.attach")}
            aria-label={t("chat.attach")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-1"
          >
            <PaperclipIcon className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />

          {sending ? (
            <button
              type="button"
              onClick={cancel}
              aria-label={t("chat.cancel")}
              title={t("chat.cancel")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-invert text-txt-invert transition hover:bg-invert-hover"
            >
              <SquareIcon className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={value.trim().length === 0}
              aria-label={t("chat.send")}
              title={t("chat.send")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-invert text-txt-invert
                transition hover:bg-invert-hover disabled:cursor-not-allowed disabled:bg-bg-3"
            >
              <ArrowUpIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 text-center text-[11px] text-txt-2">
        {transcribing
          ? t("voice.transcribing")
          : recording
            ? t("voice.recording")
            : sending
              ? t("chat.generating")
              : t("chat.sendHint")}
        {voiceError != null && (
          <span className="ml-2 text-danger">
            {voiceError}
            <button type="button" onClick={() => setKeyPrompt(true)} className="ml-1 underline">
              ⚙
            </button>
          </span>
        )}
      </div>

      {keyPrompt && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setKeyPrompt(false); }}>
          <div className="w-[min(440px,94vw)] rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-pop)]">
            <div className="text-[14px] font-semibold text-txt-0">{t("voice.keyTitle")}</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-txt-2">{t("voice.keyHint")}</p>
            <input
              type="password"
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
              placeholder={t("voice.keyPlaceholder")}
              autoFocus
              onKeyDown={(event) => { if (event.key === "Enter") void saveVoiceKey(); }}
              className="mt-3 h-9 w-full rounded-lg border border-border bg-bg-0 px-3 text-[13px] text-txt-0 focus:border-accent/50 focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setKeyPrompt(false)} className="h-8 rounded-full border border-border px-3.5 text-[12.5px] text-txt-1 hover:bg-bg-2">
                {t("common.cancel")}
              </button>
              <button type="button" onClick={() => void saveVoiceKey()} disabled={savingKey} className="h-8 rounded-full bg-bg-invert px-3.5 text-[12.5px] font-medium text-txt-invert hover:bg-invert-hover disabled:opacity-50">
                {savingKey ? "…" : t("voice.keySave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Converts a recorded blob to a base64 data string for the API. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
