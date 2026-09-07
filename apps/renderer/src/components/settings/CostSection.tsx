import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { formatCostUsd } from "../../lib/api";
import { useCost, currentMonthUsd } from "../../stores/cost";
import { useSettings } from "../../stores/settings";
import { Button } from "../ui/Button";

/** Settings tab: usage cost + monthly budget warning. */
export function CostSection() {
  const { t } = useTranslation();
  const stats = useCost((state) => state.stats);
  const loading = useCost((state) => state.loading);
  const error = useCost((state) => state.error);
  const refresh = useCost((state) => state.refresh);
  const budget = useSettings((state) => state.monthlyBudgetUsd);
  const setBudget = useSettings((state) => state.setMonthlyBudgetUsd);

  useEffect(() => {
    if (stats == null) void refresh();
  }, [stats, refresh]);

  const monthUsd = currentMonthUsd(stats);
  const maxMonth = Math.max(0.000001, ...(stats?.months.map((month) => month.usd) ?? [0]));
  const maxModel = Math.max(0.000001, ...(stats?.by_model.map((model) => model.usd) ?? [0]));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="rounded-xl border border-border bg-bg-1 p-4">
        <div className="flex items-center justify-between">
          <div className="text-[12.5px] font-semibold text-txt-0">
            {t("settings.monthlyBudget")}
            {monthUsd != null && budget != null && monthUsd > budget && (
              <span className="ml-2 rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10.5px] font-medium text-danger">
                ▲ {formatCostUsd(monthUsd)} / {formatCostUsd(budget)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="0.1"
              value={budget ?? ""}
              placeholder="—"
              onChange={(event) => {
                const value = event.target.value.trim();
                setBudget(value.length === 0 ? null : Number(value));
              }}
              className="h-8 w-24 rounded-lg border border-border bg-bg-0 px-2 text-right text-[12.5px] tabular-nums text-txt-0 focus:border-accent/50 focus:outline-none"
            />
            <span className="text-[11.5px] text-txt-2">USD</span>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-txt-2">{t("settings.budgetHint")}</p>
      </section>

      <section className="rounded-xl border border-border bg-bg-1 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[12.5px] font-semibold text-txt-0">{t("settings.statsTotal")}</div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
            {t("settings.refreshStats")}
          </Button>
        </div>
        <div className="text-[22px] font-semibold tabular-nums text-txt-0">
          {stats != null ? formatCostUsd(stats.total_usd) : "—"}
        </div>
        {error != null && <div className="mt-1 text-[11.5px] text-danger">{error}</div>}
        {stats == null && !loading && error == null && (
          <div className="mt-2 text-[12px] text-txt-2">{t("settings.noCostData")}</div>
        )}
      </section>

      {stats != null && (
        <>
          <section className="rounded-xl border border-border bg-bg-1 p-4">
            <div className="mb-2 text-[12.5px] font-semibold text-txt-0">{t("settings.statsMonthly")}</div>
            <div className="space-y-1.5">
              {stats.months.map((month) => (
                <div key={month.month} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 font-mono text-[11px] text-txt-2">{month.month}</span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-2">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.min(100, (month.usd / maxMonth) * 100)}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-[11.5px] tabular-nums text-txt-1">
                    {formatCostUsd(month.usd)}
                  </span>
                </div>
              ))}
              {stats.months.length === 0 && <div className="text-[12px] text-txt-2">{t("settings.noCostData")}</div>}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-bg-1 p-4">
            <div className="mb-2 text-[12.5px] font-semibold text-txt-0">{t("settings.statsModels")}</div>
            <div className="space-y-1.5">
              {stats.by_model.map((model) => (
                <div key={model.model_id} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 truncate text-[11.5px] text-txt-1" title={`${model.display_name} · ${model.provider_name}`}>
                    {model.display_name}
                  </span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-2">
                    <div
                      className="h-full rounded-full bg-accent-2"
                      style={{ width: `${Math.min(100, (model.usd / maxModel) * 100)}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right text-[11.5px] tabular-nums text-txt-2">
                    {formatCostUsd(model.usd)} · {model.replies}×
                  </span>
                </div>
              ))}
              {stats.by_model.length === 0 && <div className="text-[12px] text-txt-2">{t("settings.noCostData")}</div>}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-bg-1 p-4">
            <div className="mb-2 text-[12.5px] font-semibold text-txt-0">{t("settings.statsConversations")}</div>
            <div className="space-y-1.5">
              {stats.by_conversation.map((row) => (
                <div key={row.conversation_id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-txt-1">
                    {row.title ?? t("sidebar.untitled")}
                  </span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-txt-2">{formatCostUsd(row.usd)}</span>
                </div>
              ))}
              {stats.by_conversation.length === 0 && (
                <div className="text-[12px] text-txt-2">{t("settings.noCostData")}</div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
