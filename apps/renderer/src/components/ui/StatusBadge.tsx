import { useTranslation } from "react-i18next";

import { useConnection } from "../../stores/connection";

/** Backend liveness indicator: WS status with ping RTT, HTTP /health as fallback. */
export function StatusBadge() {
  const { t } = useTranslation();
  const status = useConnection((s) => s.status);
  const latencyMs = useConnection((s) => s.latencyMs);

  const dotColor =
    status === "online" ? "bg-success" : status === "connecting" ? "bg-warn" : "bg-danger";
  const dotPulse = status === "connecting" ? "animate-pulse" : "";

  const label =
    status === "online"
      ? t("status.connected")
      : status === "connecting"
        ? t("status.connecting")
        : t("status.offline");

  return (
    <div className="flex items-center gap-2 text-[13px] text-txt-1" role="status">
      <span className={`h-2 w-2 rounded-full ${dotColor} ${dotPulse}`} aria-hidden />
      <span>{label}</span>
      {status === "online" && latencyMs != null && (
        <span className="rounded bg-bg-2 px-1.5 py-0.5 text-[11px] tabular-nums text-txt-2">
          {t("status.latency", { ms: latencyMs })}
        </span>
      )}
    </div>
  );
}
