"use client";

import { AudioLines, Bot, Loader2, MessageSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "./api";
import {
  RankedBarChart,
  SegmentsPerDayChart,
  SOURCE_VAR,
  ValueLegend,
} from "./billing-charts";
import { errorMessage } from "./errors";

export type AiModelUsage = {
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

/** Un point de la courbe quotidienne — jour TORONTO côté base, GMT côté Twilio. */
export type DailyPoint = { date: string; costUsd: number };

export type SmsDailyVolume = {
  date: string;
  outboundMessages: number;
  outboundSegments: number;
  inboundMessages: number;
  inboundSegments: number;
};

export type ConsumptionReport = {
  from: string;
  to: string;
  ai: {
    turns: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    byModel: AiModelUsage[];
    daily: DailyPoint[];
    /** Dépense à vie et crédits du COMPTE OpenRouter — l'ancre, ou null. */
    account: { totalUsageUsd: number; totalCreditsUsd: number } | null;
  };
  sms: {
    outboundMessages: number;
    outboundSegments: number;
    inboundMessages: number;
    inboundSegments: number;
    segmentCostUsd: number;
    estimatedCostUsd: number;
    realCostUsd: number | null;
    costSource: "twilio" | "estimate";
    costUsd: number;
    /** Frais de transporteur facturés à part par Twilio ; null = indisponible. */
    carrierFeesUsd: number | null;
    dailyVolume: SmsDailyVolume[];
    dailyCost: { date: string; costUsd: number; messages: number }[] | null;
    /** Solde du compte Twilio — affiché dans les réservoirs, en haut de page. */
    balance: { balanceUsd: number; currency: string } | null;
  };
  /** Notes d'appel IA — coût RÉEL (usage.cost d'OpenRouter). */
  transcripts: {
    calls: number;
    audioSeconds: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    failed: number;
    skipped: number;
    byModel: TranscriptModelUsage[];
    daily: DailyPoint[];
  };
};

export type TranscriptModelUsage = {
  model: string;
  calls: number;
  audioSeconds: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

/**
 * L'étiquette d'un modèle SUR UN AXE.
 *
 * « google/gemini-2.5-flash » ne tient pas dans la gouttière d'un graphique
 * horizontal : le texte déborde à gauche et se fait rogner en
 * « ogle/gemini-2.5-flash ». Le vendeur est la partie la moins informative, et
 * le tableau juste dessous porte l'identifiant complet — l'axe garde le nom.
 */
function modelTick(model: string): string {
  const short = model.split("/").pop() || model;
  return short.length > 22 ? `${short.slice(0, 21)}…` : short;
}

/**
 * Les étiquettes d'une liste de modèles, GARANTIES DISTINCTES.
 *
 * L'axe d'un graphique horizontal regroupe par étiquette : deux modèles
 * raccourcis au même texte fusionneraient en UNE barre, et le coût de l'un
 * disparaîtrait. Dès qu'un raccourci se répète, tous ceux qui se cognent
 * reprennent leur identifiant complet.
 */
function modelTicks(models: string[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const m of models) {
    const short = modelTick(m);
    seen.set(short, (seen.get(short) ?? 0) + 1);
  }
  return new Map(
    models.map((m) => {
      const short = modelTick(m);
      return [m, (seen.get(short) ?? 0) > 1 ? m : short];
    }),
  );
}

/** Une tuile chiffre + libellé. */
function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-lg font-semibold tabular-nums ${muted ? "text-muted-foreground" : ""}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Sections SMS et IA de la page de consommation. La téléphonie voip.ms vit
 * dans `BillingClient` (elle vient d'une API lente) ; ici, tout vient de la
 * base et s'affiche vite. Le SMS est ESTIMÉ (badge), l'IA est RÉEL.
 */
export function ConsumptionSections({
  data,
  loading,
  error,
  money,
  moneyAxis,
  nf,
  dayLabel,
  onRateSaved,
}: {
  data: ConsumptionReport | null;
  loading: boolean;
  /** Le dernier chargement a échoué : « indisponible », jamais « zéro ». */
  error?: boolean;
  money: (n: number | null) => string;
  /** Graduations d'un axe d'argent — précision adaptée à l'échelle. */
  moneyAxis: (n: number) => string;
  nf: Intl.NumberFormat;
  /** « 2026-08-12 » → « 12 août » — la même mise en forme que la pile du haut. */
  dayLabel: (date: string) => string;
  /** Après enregistrement du taux SMS : recharger pour refléter la nouvelle estimation. */
  onRateSaved: () => void;
}) {
  const t = useTranslations("admin");
  const [rate, setRate] = useState<string>("");
  const [savingRate, setSavingRate] = useState(false);

  const sms = data?.sms;
  const ai = data?.ai;
  const transcripts = data?.transcripts;

  // Sans données : distinguer « en cours », « indisponible » et « rien ». Un
  // échec ne doit PAS se lire comme « 0 $ dépensé » sur une page de dépense.
  const noDataNode = loading ? (
    <p className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
    </p>
  ) : error ? (
    <p className="rounded-md border border-dashed p-4 text-sm text-destructive">
      {t("billing.unavailable")}
    </p>
  ) : null;

  const saveRate = async () => {
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0) return;
    setSavingRate(true);
    try {
      await api("/api/admin/consumption", {
        method: "PATCH",
        body: JSON.stringify({ smsSegmentCostUsd: value }),
      });
      toast.success(t("billing.smsRateSaved"));
      setRate("");
      onRateSaved();
    } catch (err) {
      toast.error(errorMessage(t, err));
    } finally {
      setSavingRate(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── SMS ──────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("billing.sectionSms")}</h2>
          {/* Réel (facturé par Twilio) ou estimé (repli par segments) — le badge
              le dit, on ne fait jamais passer une estimation pour une facture. */}
          <Badge variant={sms?.costSource === "twilio" ? "default" : "secondary"}>
            {t(sms?.costSource === "twilio" ? "billing.realBadge" : "billing.estimatedBadge")}
          </Badge>
          {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>

        {!data ? (
          noDataNode
        ) : sms && (sms.outboundMessages > 0 || sms.inboundMessages > 0) ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label={`${t("billing.smsOut")} · ${t("billing.segments")}`}
                value={`${nf.format(sms.outboundSegments)}`}
              />
              <Stat
                label={t("billing.smsOut")}
                value={t("billing.msgCount", { count: nf.format(sms.outboundMessages) })}
                muted
              />
              <Stat
                label={`${t("billing.smsIn")} · ${t("billing.segments")}`}
                value={`${nf.format(sms.inboundSegments)}`}
              />
              <Stat
                label={sms.costSource === "twilio" ? t("billing.smsCostReal") : t("billing.smsEstimate")}
                value={money(sms.costUsd)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {sms.costSource === "twilio"
                ? t("billing.smsSourceReal")
                : t("billing.smsSourceEstimate")}
            </p>

            {/* Les frais de transporteur sont une catégorie Twilio DISTINCTE :
                la ligne « SMS » ne les contient pas. On les montre à côté,
                jamais fondus dedans — et « indisponible » n'est pas « 0 ». */}
            <ValueLegend
              className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs"
              items={[
                {
                  key: "messages",
                  color: SOURCE_VAR.sms,
                  label: t("billing.smsMessagesCost"),
                  value: money(sms.costUsd),
                },
                {
                  // Gris de RETRAIT : deux pastilles de la même teinte dans une
                  // même liste annonceraient deux fois la même chose.
                  key: "fees",
                  color: "var(--viz-deemph)",
                  label: t("billing.smsCarrierFees"),
                  value: sms.carrierFeesUsd === null ? null : money(sms.carrierFeesUsd),
                },
              ]}
            />

            {/* Volume par journée — des SEGMENTS, l'unité facturée. Ce
                graphique ne devient jamais un graphique d'argent. */}
            <SegmentsPerDayChart
              data={sms.dailyVolume.map((d) => ({
                key: d.date,
                label: dayLabel(d.date),
                outbound: d.outboundSegments,
                inbound: d.inboundSegments,
              }))}
              labels={{ outbound: t("billing.smsOut"), inbound: t("billing.smsIn") }}
              nf={nf}
            />

            {/* Le JUMEAU TABULAIRE : aucune valeur du graphique n'est
                accessible au seul survol. */}
            <details>
              <summary className="flex min-h-11 cursor-pointer list-none items-center text-xs text-muted-foreground underline-offset-2 hover:underline md:min-h-8">
                {t("billing.showSegmentTable")}
              </summary>
              <div className="mt-2 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky left-0 z-10 bg-card">
                        {t("billing.day")}
                      </TableHead>
                      <TableHead className="text-right">
                        {`${t("billing.smsOut")} · ${t("billing.segments")}`}
                      </TableHead>
                      <TableHead className="text-right">
                        {`${t("billing.smsIn")} · ${t("billing.segments")}`}
                      </TableHead>
                      <TableHead className="text-right">{t("billing.smsOut")}</TableHead>
                      <TableHead className="text-right">{t("billing.smsIn")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sms.dailyVolume.map((d) => (
                      <TableRow key={d.date}>
                        <TableCell className="sticky left-0 z-10 bg-card whitespace-nowrap">
                          {dayLabel(d.date)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {nf.format(d.outboundSegments)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {nf.format(d.inboundSegments)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {nf.format(d.outboundMessages)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {nf.format(d.inboundMessages)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>

            {/* Taux d'estimation — réglable, car Twilio ne nous donne pas le prix. */}
            <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-3">
              <div className="space-y-1">
                <Label htmlFor="sms-rate" className="text-xs">
                  {t("billing.smsRateLabel")}
                </Label>
                <Input
                  id="sms-rate"
                  inputMode="decimal"
                  className="h-9 w-32"
                  placeholder={String(sms.segmentCostUsd)}
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                disabled={savingRate || rate.trim() === ""}
                onClick={() => void saveRate()}
              >
                {savingRate ? <Loader2 className="animate-spin" /> : null}
                {t("billing.smsRateSave")}
              </Button>
              <p className="w-full text-xs text-muted-foreground sm:w-auto sm:flex-1">
                {t("billing.smsRateNote")}
              </p>
            </div>
          </>
        ) : (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("billing.smsEmpty")}
          </p>
        )}
      </section>

      {/* ── IA ───────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("billing.sectionAi")}</h2>
          <Badge variant="secondary">{t("billing.realBadge")}</Badge>
          {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>

        {!data ? (
          noDataNode
        ) : ai && ai.turns > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t("billing.aiTurns")} value={nf.format(ai.turns)} muted />
              <Stat label={t("billing.aiTokensIn")} value={nf.format(ai.tokensIn)} muted />
              <Stat label={t("billing.aiTokensOut")} value={nf.format(ai.tokensOut)} muted />
              <Stat label={t("billing.aiCost")} value={money(ai.costUsd)} />
            </div>

            {/* L'ANCRE : ce que le compte OpenRouter a réellement brûlé — le
                seul chiffre IA qui ne dépende pas de notre propre comptage.
                Les traces d'avant le 2026-08-26 sous-comptaient (~1/8) :
                l'écart entre la somme des périodes et ce total est normal
                pour l'historique, plus pour le neuf. */}
            {ai.account ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span>
                  {t("billing.aiAccountUsage")}{" "}
                  <span className="font-semibold text-foreground tabular-nums">
                    {money(ai.account.totalUsageUsd)}
                  </span>
                </span>
                <span>
                  {t("billing.aiAccountRemaining")}{" "}
                  <span className="font-semibold text-foreground tabular-nums">
                    {money(Math.max(0, ai.account.totalCreditsUsd - ai.account.totalUsageUsd))}
                  </span>
                </span>
                <span className="w-full sm:w-auto sm:flex-1">{t("billing.aiAccountNote")}</span>
              </div>
            ) : null}

            {/* Quel modèle mange le budget — une seule série, donc une seule
                teinte : colorier chaque barre selon sa valeur redirait ce que
                sa longueur montre déjà. Masqué sous deux modèles. */}
            <RankedBarChart
              data={(() => {
                const ticks = modelTicks(ai.byModel.map((m) => m.model));
                return ai.byModel.map((m) => ({
                  key: m.model,
                  label: ticks.get(m.model) ?? m.model,
                  value: m.costUsd,
                }));
              })()}
              color={SOURCE_VAR.ai}
              format={(n) => money(n)}
              formatAxis={moneyAxis}
              seriesName={t("billing.aiCost")}
            />

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("billing.model")}</TableHead>
                    <TableHead className="text-right">{t("billing.aiTurns")}</TableHead>
                    <TableHead className="text-right">{t("billing.aiTokensIn")}</TableHead>
                    <TableHead className="text-right">{t("billing.aiTokensOut")}</TableHead>
                    <TableHead className="text-right">{t("billing.aiCost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ai.byModel.map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="max-w-48 truncate font-mono text-xs">{m.model}</TableCell>
                      <TableCell className="text-right tabular-nums">{nf.format(m.turns)}</TableCell>
                      <TableCell className="text-right tabular-nums">{nf.format(m.tokensIn)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {nf.format(m.tokensOut)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(m.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("billing.aiEmpty")}
          </p>
        )}
      </section>

      {/* ── Notes d'appel IA ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <AudioLines className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("billing.sectionTranscripts")}</h2>
          <Badge variant="secondary">{t("billing.realBadge")}</Badge>
          {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>

        {!data ? (
          noDataNode
        ) : transcripts &&
          (transcripts.calls > 0 ||
            transcripts.costUsd > 0 ||
            // Une période 100 % échecs/écartés doit MONTRER ces compteurs —
            // « aucune note » cacherait une panne (et sa dépense éventuelle).
            transcripts.failed > 0 ||
            transcripts.skipped > 0) ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t("billing.transcriptCalls")} value={nf.format(transcripts.calls)} muted />
              <Stat
                label={t("billing.minutes")}
                value={nf.format(Math.round(transcripts.audioSeconds / 60))}
                muted
              />
              <Stat label={t("billing.aiTokensOut")} value={nf.format(transcripts.tokensOut)} muted />
              <Stat label={t("billing.aiCost")} value={money(transcripts.costUsd)} />
            </div>

            {transcripts.failed > 0 || transcripts.skipped > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("billing.transcriptIssues", {
                  failed: nf.format(transcripts.failed),
                  skipped: nf.format(transcripts.skipped),
                })}
              </p>
            ) : null}

            <RankedBarChart
              data={(() => {
                const ticks = modelTicks(transcripts.byModel.map((m) => m.model));
                return transcripts.byModel.map((m) => ({
                  key: m.model,
                  label: ticks.get(m.model) ?? m.model,
                  value: m.costUsd,
                }));
              })()}
              color={SOURCE_VAR.notes}
              format={(n) => money(n)}
              formatAxis={moneyAxis}
              seriesName={t("billing.aiCost")}
            />

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("billing.model")}</TableHead>
                    <TableHead className="text-right">{t("billing.transcriptCalls")}</TableHead>
                    <TableHead className="text-right">{t("billing.minutes")}</TableHead>
                    <TableHead className="text-right">{t("billing.aiTokensOut")}</TableHead>
                    <TableHead className="text-right">{t("billing.aiCost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transcripts.byModel.map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="max-w-48 truncate font-mono text-xs">{m.model}</TableCell>
                      <TableCell className="text-right tabular-nums">{nf.format(m.calls)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {nf.format(Math.round(m.audioSeconds / 60))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {nf.format(m.tokensOut)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(m.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("billing.transcriptEmpty")}
          </p>
        )}
      </section>
    </div>
  );
}
