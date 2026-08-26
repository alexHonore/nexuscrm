"use client";

import { Bot, Loader2, MessageSquare } from "lucide-react";
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
import { errorMessage } from "./errors";

export type AiModelUsage = {
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
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
  };
};

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
  nf,
  onRateSaved,
}: {
  data: ConsumptionReport | null;
  loading: boolean;
  /** Le dernier chargement a échoué : « indisponible », jamais « zéro ». */
  error?: boolean;
  money: (n: number | null) => string;
  nf: Intl.NumberFormat;
  /** Après enregistrement du taux SMS : recharger pour refléter la nouvelle estimation. */
  onRateSaved: () => void;
}) {
  const t = useTranslations("admin");
  const [rate, setRate] = useState<string>("");
  const [savingRate, setSavingRate] = useState(false);

  const sms = data?.sms;
  const ai = data?.ai;

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
    </div>
  );
}
