import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useArtifacts } from "../../stores/artifacts";

const BASE =
  "max-w-none text-[14.5px] leading-relaxed text-txt-0 [&_a]:text-accent-2 [&_a]:underline " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-txt-1 " +
  "[&_code]:rounded [&_code]:bg-bg-1 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_code]:text-[#8b5a3c] " +
  "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:font-semibold " +
  "[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto " +
  "[&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 " +
  "[&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5";

/** Fenced-code header renderer: language tag + copy + open-in-panel. */
function PreBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const pushArtifact = useArtifacts((state) => state.push);
  const openPanel = useArtifacts((state) => state.open);

  // Extract text + language from the nested <code> child.
  let language = "text";
  let code = "";
  if (children != null && Array.isArray(children) && children.length === 1) {
    const only = children[0] as { props?: { className?: string; children?: ReactNode } };
    const className = only?.props?.className ?? "";
    language = /language-([\w+-]+)/.exec(className)?.[1] ?? "text";
    code = flatten(only?.props?.children);
  } else {
    code = flatten(children);
  }

  return (
    <div className="group/pre relative my-2">
      <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-border bg-bg-1 px-2.5 py-1">
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-txt-2">
          {language}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(code)}
            className="rounded px-1.5 py-0.5 text-[10.5px] text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
          >
            {t("artifacts.copy")}
          </button>
          <button
            type="button"
            onClick={() => {
              const id = pushArtifact(language, code);
              openPanel(id);
              void import("../../stores/settings").then(({ useSettings }) =>
                useSettings.getState().rightPanelOpen
                  ? undefined
                  : useSettings.getState().toggleRightPanel(),
              );
            }}
            className="rounded px-1.5 py-0.5 text-[10.5px] text-accent-2 transition hover:bg-accent/10"
          >
            {t("artifacts.openInPanel")}
          </button>
        </span>
      </div>
      <pre className="!mt-0 !rounded-t-none rounded-b-lg border border-border bg-bg-1 p-3 [&_code]:bg-transparent [&_code]:text-[12.5px] [&_code]:text-txt-1">
        {children}
      </pre>
    </div>
  );
}

function flatten(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (typeof node === "object" && "props" in (node as { props?: unknown })) {
    return flatten((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/** Shared markdown renderer with the artifact-aware code headers. */
export const MarkdownBody = memo(function MarkdownBody({ content }: { content: string }) {
  return (
    <div className={BASE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ pre: PreBlock as never }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
