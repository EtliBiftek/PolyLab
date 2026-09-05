import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { useChat } from "../../stores/chat";
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "../ui/Icons";

export function Composer() {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sending = useChat((state) => state.sending);
  const send = useChat((state) => state.send);
  const cancel = useChat((state) => state.cancel);

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (text.length === 0 || sending) return;
    void send(text);
    setValue("");
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-bg-1 p-2.5 shadow-lg shadow-black/20 transition focus-within:border-txt-2/40">
        <div className="flex items-end gap-2">
          <button
            type="button"
            disabled
            title={t("common.comingSoonPhase3")}
            aria-label={t("chat.attach")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-txt-2 transition hover:bg-bg-2 hover:text-txt-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PaperclipIcon className="h-4 w-4" />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={sending}
            onInput={autoGrow}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("chat.composerPlaceholder")}
            className="max-h-[220px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm leading-relaxed
              text-txt-0 placeholder:text-txt-2 focus:outline-none disabled:opacity-60"
          />

          {sending ? (
            <button
              type="button"
              onClick={cancel}
              aria-label={t("chat.cancel")}
              title={t("chat.cancel")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-3 text-txt-0 transition hover:bg-border"
            >
              <SquareIcon className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={value.trim().length === 0}
              aria-label={t("chat.send")}
              title={`${t("chat.send")} (Ctrl+Enter)`}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl accent-gradient text-white
                transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUpIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="px-1 pb-0.5 pt-1 text-[11px] text-txt-2">
          {sending ? t("chat.generating") : t("chat.sendHint")}
        </div>
      </div>
    </div>
  );
}
