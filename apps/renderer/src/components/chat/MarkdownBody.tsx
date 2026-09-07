import { memo, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

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

/** react-markdown emits the fenced-code language in the nested <code>. */
function codeLanguage(children: ReactNode): { language: string; code: string } {
  let language = "text";
  let code = "";
  const only =
    children != null && Array.isArray(children)
      ? (children[0] as { props?: { className?: string; children?: ReactNode } })
      : (children as { props?: { className?: string; children?: ReactNode } });
  const className = only?.props?.className ?? "";
  const match = /language-([\w+-]+)/.exec(className);
  if (match != null) {
    language = match[1] ?? "text";
    code = flatten(only?.props?.children);
  } else {
    code = flatten(children);
  }
  return { language, code };
}

/** Fenced Mermaid block: lazy-renders the diagram inside the markdown. */
function MermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // jsdom (vitest) has no layout APIs mermaid needs — render the placeholder.
    if (typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom")) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          themeVariables: {
            primaryColor: "var(--bg-2)",
            primaryTextColor: "var(--txt-0)",
            primaryBorderColor: "var(--border)",
            lineColor: "var(--txt-2)",
            fontFamily: "inherit",
          },
          securityLevel: "strict",
        });
        const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
        const rendered = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered.svg);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-warn/40 bg-warn/10">
        <div className="flex items-center justify-between border-b border-warn/30 px-2.5 py-1">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-warn">mermaid</span>
          <span className="text-[11px] text-txt-2">
            {error != null ? t("markdown.mermaidError") : t("markdown.mermaidUnsupported")}
          </span>
        </div>
        <pre className="m-0 whitespace-pre-wrap p-3 text-[12.5px] text-txt-1">{code}</pre>
      </div>
    );
  }
  return (
    <div className="my-2 overflow-x-auto rounded-lg border border-border bg-surface p-2">
      {svg != null ? (
        <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="flex items-center gap-2 px-2 py-6 text-[12px] text-txt-2">
          <span className="h-3 w-3 animate-spin rounded-full border border-txt-2 border-t-transparent" />
          {t("markdown.mermaidLoading")}
        </div>
      )}
    </div>
  );
}

/** Fenced-code header renderer: language tag + copy + open-in-panel. */
function PreBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const pushArtifact = useArtifacts((state) => state.push);
  const openPanel = useArtifacts((state) => state.open);
  const { language, code } = codeLanguage(children);

  // Mermaid fences bypass the generic code panel entirely.
  if (language === "mermaid") return <MermaidBlock code={code} />;

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

/** Shared markdown renderer: GFM + KaTeX math + Mermaid diagrams. */
export const MarkdownBody = memo(function MarkdownBody({ content }: { content: string }) {
  return (
    <div className={BASE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ pre: PreBlock as never }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
