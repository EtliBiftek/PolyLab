import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { useChat } from "../../stores/chat";
import { ModelPicker } from "../models/ModelPicker";
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

  // Enter sends; Shift+Enter inserts a newline (claude.ai behavior).
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      {/* claude.ai composer: gray card, hairline border, soft shadow. Bottom bar
          carries the model picker (with per-model think) and the send button. */}
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface p-2.5 shadow-[0_2px_14px_rgba(31,30,29,0.07)] transition focus-within:border-[#c9c6b8]">
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

          <div className="flex-1" />

          <button
            type="button"
            disabled
            title={t("common.comingSoonPhase3")}
            aria-label={t("chat.attach")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PaperclipIcon className="h-4 w-4" />
          </button>

          {sending ? (
            <button
              type="button"
              onClick={cancel}
              aria-label={t("chat.cancel")}
              title={t("chat.cancel")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-invert text-txt-invert transition hover:bg-[#3d3d3a]"
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
                transition hover:bg-[#3d3d3a] disabled:cursor-not-allowed disabled:bg-[#c9c6b8]"
            >
              <ArrowUpIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 text-center text-[11px] text-txt-2">
        {sending ? t("chat.generating") : t("chat.sendHint")}
      </div>
    </div>
  );
}
