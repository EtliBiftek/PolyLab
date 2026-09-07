import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  deleteComparison,
  getComparison,
  listComparisons,
  setComparisonWinner,
  type Comparison,
  type ComparisonDetail,
} from "../../lib/api";
import { useSettings } from "../../stores/settings";
import { CloseIcon, TrashIcon, TrophyIcon } from "../ui/Icons";

/** Persistent comparison records: race winner + per-model answers. */
export function ComparisonsModal() {
  const { t } = useTranslation();
  const open = useSettings((state) => state.comparisonsOpen);
  const setOpen = useSettings((state) => state.setComparisonsOpen);
  const [items, setItems] = useState<Comparison[]>([]);
  const [selected, setSelected] = useState<ComparisonDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setItems(await listComparisons());
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  if (!open) return null;

  const openDetail = async (comparison: Comparison) => {
    try {
      setSelected(await getComparison(comparison.id));
    } catch {
      /* ignore */
    }
  };

  const markWinner = async (entryId: string) => {
    if (selected == null) return;
    try {
      setSelected(await setComparisonWinner(selected.id, entryId));
    } catch {
      /* ignore */
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteComparison(id);
      if (selected?.id === id) setSelected(null);
      await load();
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="flex h-[min(640px,92vh)] w-[min(960px,96vw)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <div className="text-[14px] font-semibold text-txt-0">{t("comparisons.title")}</div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title={t("common.close")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 hover:bg-bg-2 hover:text-txt-0"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="w-64 shrink-0 space-y-1 overflow-y-auto border-r border-border p-2">
            {loading && <div className="px-2 py-3 text-[12px] text-txt-2">{t("common.loading")}</div>}
            {!loading && items.length === 0 && (
              <div className="px-2 py-4 text-[12px] leading-relaxed text-txt-2">{t("comparisons.empty")}</div>
            )}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void openDetail(item)}
                className={`block w-full rounded-lg border px-3 py-2 text-left transition ${
                  selected?.id === item.id ? "border-border bg-bg-3" : "border-transparent hover:bg-bg-2"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-txt-0">
                    {item.question ?? t("comparisons.question")}
                  </span>
                  {item.winner_entry_id != null && <TrophyIcon className="h-3 w-3 shrink-0 text-accent" />}
                </div>
                <div className="mt-0.5 text-[10.5px] text-txt-2">
                  {item.kind} · {new Date(item.created_at).toLocaleDateString()}
                </div>
              </button>
            ))}
          </aside>
          <main className="min-h-0 flex-1 overflow-y-auto p-4">
            {selected == null && (
              <div className="px-3 pt-8 text-center text-[12.5px] text-txt-2">{t("comparisons.empty")}</div>
            )}
            {selected != null && (
              <div className="space-y-3">
                <div className="rounded-xl border border-border bg-bg-1 p-4">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-txt-2">
                    {t("comparisons.question")}
                  </div>
                  <div className="mt-1 text-[13.5px] text-txt-0">{selected.question ?? "—"}</div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {selected.entries.map((entry) => {
                    const winner = selected.winner_entry_id === entry.id;
                    return (
                      <div
                        key={entry.id}
                        className={`flex min-w-0 flex-col rounded-xl border bg-bg-1 ${
                          winner ? "border-accent/60 ring-1 ring-accent/40" : "border-border"
                        }`}
                      >
                        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                          {winner ? <TrophyIcon className="h-4 w-4 shrink-0 text-accent" /> : null}
                          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-txt-0">
                            {entry.resolved_model ?? entry.model_id}
                          </span>
                          <button
                            type="button"
                            onClick={() => void markWinner(entry.id)}
                            disabled={winner}
                            title={t("race.markWinner")}
                            className="flex h-6 w-6 items-center justify-center rounded-md text-txt-2 transition hover:bg-bg-2 hover:text-txt-0 disabled:opacity-40"
                          >
                            <TrophyIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="max-h-52 min-h-0 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[12.5px] leading-relaxed text-txt-1">
                          {entry.content || "—"}
                        </div>
                        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10.5px] tabular-nums text-txt-2">
                          <span>
                            {entry.tokens_in ?? 0} → {entry.tokens_out ?? 0}
                          </span>
                          {entry.cost_usd != null && <span>≈${entry.cost_usd.toFixed(4)}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => void remove(selected.id)}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-danger transition hover:bg-danger/10"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    {t("comparisons.delete")}
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
