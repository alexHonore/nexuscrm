"use client";

import { useTranslations } from "next-intl";
import { CALL_QUALITY_LOOK } from "@/components/look";
import { Button } from "@/components/ui/button";
import { useTelephony } from "./telephony-context";

export function CallQualityPanel() {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const sample = tel.quality;
  const inCall = tel.callState === "active" || tel.callState === "held";
  if (!sample && !inCall) return null;
  const level = sample?.microphone.state === "interrupted" ? "poor" : sample?.level ?? "unknown";
  const { Icon, color } = CALL_QUALITY_LOOK[level];
  const metric = (value: number | null | undefined, unit: "percent" | "ms") =>
    value === null || value === undefined ? t("quality.unavailable") : t(`quality.${unit}`, { value: Math.round(value * 10) / 10 });

  return (
    <details className="mt-3 w-full rounded-xl border bg-background text-left text-xs">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2">
        <Icon aria-hidden className="size-4 shrink-0" style={{ color }} />
        <span>
          {inCall ? t("quality.title") : t("quality.lastCall")}
          {" · "}
          {t(`quality.${tel.held ? "held" : level}`)}
        </span>
      </summary>
      <div className="space-y-3 border-t p-3">
        <p className="text-muted-foreground">{t("quality.scope")}</p>
        {inCall && !tel.held && (level === "fair" || level === "poor") ? (
          <p role="status">{t(sample?.microphone.state === "interrupted" ? "quality.micInterrupted" : "quality.networkAdvice")}</p>
        ) : null}
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
          <dt>{t("quality.sentLoss")}</dt><dd>{metric(sample?.outbound.lossPercent, "percent")}</dd>
          <dt>{t("quality.sentJitter")}</dt><dd>{metric(sample?.outbound.jitterMs, "ms")}</dd>
          <dt>{t("quality.receivedLoss")}</dt><dd>{metric(sample?.inbound.lossPercent, "percent")}</dd>
          <dt>{t("quality.receivedJitter")}</dt><dd>{metric(sample?.inbound.jitterMs, "ms")}</dd>
          <dt>{t("quality.delay")}</dt><dd>{metric(sample?.roundTripMs, "ms")}</dd>
          <dt>{t("quality.codec")}</dt><dd>{sample?.codec ?? t("quality.unavailable")}</dd>
        </dl>
        <div className="space-y-1">
          <p className="break-words">{t("audio.input")}: {sample?.microphone.name ?? t("audio.systemDefault")}</p>
          <p>{t(`quality.mic.${sample?.microphone.state ?? "unknown"}`)}</p>
          {inCall && !tel.held && sample?.microphone.level !== null && sample?.microphone.level !== undefined ? (
            <label className="flex items-center gap-2">
              <span>{t("quality.micLevel")}</span>
              <meter className="h-3 min-w-0 flex-1" min={0} max={1} value={sample.microphone.level} />
            </label>
          ) : null}
        </div>
        <p className="text-muted-foreground">{t("quality.captureAdvice")}</p>
        <Button variant="outline" className="min-h-11 w-full whitespace-normal" disabled={!sample} onClick={tel.exportQuality}>
          {t("quality.export")}
        </Button>
      </div>
    </details>
  );
}
