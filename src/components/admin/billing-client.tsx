"use client";

import {
  Loader2,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  Timer,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { shiftDateStr, todayStr } from "@/components/analytics/period";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { api, ApiError } from "./api";
import { ConsumptionSections, type ConsumptionReport } from "./consumption-sections";
import { errorMessage } from "./errors";

/**
 * Tableau de bord de la dépense voip.ms : solde, coût par téléphoniste sur une
 * période, et résiliation d'un numéro devenu inutile — sans passer par le
 * portail voip.ms.
 *
 * Les montants affichés viennent du CDR de voip.ms. Rien n'est recalculé à
 * partir de la durée : un prix estimé ressemblerait à une facture sans en être
 * une.
 */

/**
 * Le CDR d'une longue période met du temps à revenir. Reste SOUS le budget du
 * serveur (`maxDuration = 120`) pour que l'admin voie un message clair plutôt
 * qu'une erreur de plateforme.
 */
const REPORT_TIMEOUT_MS = 110_000;

type UsageRow = {
  userId: string | null;
  name: string;
  email: string | null;
  sipUsername: string | null;
  didNumber: string | null;
  calls: number;
  answered: number;
  seconds: number;
  cost: number;
};

type UsageReport = {
  from: string;
  to: string;
  rows: UsageRow[];
  totals: { calls: number; answered: number; seconds: number; cost: number };
  balance: {
    currentBalance: number | null;
    spentTotal: number | null;
    callsTotal: number | null;
    timeTotal: number | null;
  } | null;
  costUnavailable: boolean;
};

/** Le CDR voip.ms devient trop lent au-delà d'un mois — même borne que le serveur. */
const MAX_RANGE_DAYS = 31;

const PRESETS = [7, 30] as const;

export function BillingClient() {
  const t = useTranslations("admin");
  const locale = useLocale();

  const [preset, setPreset] = useState<number | "custom">(30);
  const [from, setFrom] = useState(() => shiftDateStr(todayStr(), -29));
  const [to, setTo] = useState(() => todayStr());
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Consommation IA + SMS — vient de la base (rapide), chargée en parallèle du
  // CDR voip.ms (lent) pour que ces sections s'affichent sans attendre l'API.
  const [consumption, setConsumption] = useState<ConsumptionReport | null>(null);
  const [consLoading, setConsLoading] = useState(false);
  const [consError, setConsError] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<UsageRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Derniers chiffres tapés par l'admin pour confirmer la résiliation. */
  const [confirmDigits, setConfirmDigits] = useState("");

  // Montants en nombre nu + unité portée par les libellés (« $ US »), comme
  // ailleurs dans l'app : voip.ms facture en dollars AMÉRICAINS, et un symbole
  // « $ » seul se lirait comme des dollars canadiens au Québec.
  const amountFmt = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const money = (n: number | null) => (n === null ? "—" : amountFmt.format(n));
  const nf = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA");

  const load = useCallback(
    async (fromStr: string, toStr: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api<UsageReport>(
          `/api/admin/telephony-usage?from=${fromStr}&to=${toStr}`,
          { signal: AbortSignal.timeout(REPORT_TIMEOUT_MS) },
        );
        setReport(res);
      } catch (err) {
        // Les refus de plage ont leur propre explication : « erreur générique »
        // ne dirait pas à l'admin quoi corriger.
        const code = err instanceof ApiError ? err.code : "";
        setError(
          code === "range_too_long"
            ? t("billing.rangeTooLong", { days: MAX_RANGE_DAYS })
            : code === "invalid_range"
              ? t("billing.invalidRange")
              : errorMessage(t, err),
        );
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  /** Consommation IA + SMS depuis la base — rapide. Un échec est SIGNALÉ (pas
   *  affiché comme « zéro » : sur une page de dépense, « rien » et « inconnu »
   *  ne se confondent pas). */
  const loadConsumption = useCallback(async (fromStr: string, toStr: string) => {
    setConsLoading(true);
    setConsError(false);
    try {
      setConsumption(
        await api<ConsumptionReport>(`/api/admin/consumption?from=${fromStr}&to=${toStr}`),
      );
    } catch {
      setConsumption(null);
      setConsError(true);
    } finally {
      setConsLoading(false);
    }
  }, []);

  /** Les deux sources d'une même période : voip.ms (lent) et la base (rapide). */
  const loadAll = useCallback(
    (fromStr: string, toStr: string) => {
      void load(fromStr, toStr);
      void loadConsumption(fromStr, toStr);
    },
    [load, loadConsumption],
  );

  // Premier chargement seulement : les changements de période passent par les
  // boutons, qui appellent `loadAll` directement.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    loadAll(from, to);
  }, [loadAll, from, to]);

  const applyPreset = (days: number) => {
    const toStr = todayStr();
    const fromStr = shiftDateStr(toStr, -(days - 1));
    setPreset(days);
    setFrom(fromStr);
    setTo(toStr);
    loadAll(fromStr, toStr);
  };

  const applyCustom = () => {
    setPreset("custom");
    loadAll(from, to);
  };

  const cancelNumber = async () => {
    const did = cancelTarget?.didNumber;
    if (!did) return;
    setCancelling(true);
    try {
      await api("/api/admin/voipms/cancel-did", {
        method: "POST",
        // On envoie ce que l'admin a RÉELLEMENT tapé : renvoyer le numéro
        // affiché viderait la confirmation de son sens.
        body: JSON.stringify({ did, confirm: confirmDigits }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      toast.success(t("billing.cancelDone", { number: formatPhone(did) }));
      setCancelTarget(null);
      setConfirmDigits("");
      // Le numéro n'existe plus : on le retire TOUT DE SUITE de l'affichage.
      // Si le rechargement échoue (le CDR est lent), la ligne ne doit pas
      // continuer à proposer un bouton « Résilier » désormais sans effet.
      setReport((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((r) => (r.didNumber === did ? { ...r, didNumber: null } : r)),
            }
          : prev,
      );
      await load(from, to);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      const message =
        code === "did_not_owned"
          ? t("billing.didNotOwned")
          : code === "confirm_mismatch"
            ? t("billing.confirmMismatch")
            : errorMessage(t, err);
      // L'astuce sur l'IP ne concerne QUE les pannes d'API voip.ms.
      toast.error(message, code === "voipms" ? { description: t("users.voip.ipHint") } : undefined);
    } finally {
      setCancelling(false);
    }
  };

  /** Longueur de la plage saisie, pour bloquer AVANT l'aller-retour serveur. */
  const rangeDays =
    from && to && from <= to
      ? Math.round(
          (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000,
        ) + 1
      : 0;
  const rangeValid = rangeDays > 0 && rangeDays <= MAX_RANGE_DAYS;

  /** Les 4 derniers chiffres du numéro visé — ce que l'admin doit retaper. */
  const expectedDigits = (cancelTarget?.didNumber ?? "").replace(/\D/g, "").slice(-4);
  const confirmMatches =
    expectedDigits.length === 4 && confirmDigits.replace(/\D/g, "").slice(-4) === expectedDigits;

  const mmss = (totalSec: number) => {
    const sec = Math.max(0, Math.round(totalSec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };

  const balance = report?.balance?.currentBalance ?? null;
  /** Un solde bas est l'information qui empêche un achat de rater. */
  const balanceLow = balance !== null && balance < 25;

  const tiles: {
    key: string;
    label: string;
    value: string;
    hint?: string;
    icon: typeof Wallet;
    tone?: "warn" | "accent";
  }[] = [
    {
      key: "balance",
      label: t("billing.balance"),
      value: money(balance),
      hint: balanceLow ? t("billing.balanceLow") : undefined,
      icon: Wallet,
      tone: balanceLow ? "warn" : "accent",
    },
    {
      key: "cost",
      label: t("billing.periodCost"),
      value: report ? money(report.totals.cost) : "—",
      // La location mensuelle des numéros n'est PAS dans le CDR : le dire ici
      // évite de laisser croire que résilier un numéro fera bouger ce chiffre.
      hint: report?.costUnavailable ? t("billing.costUnavailable") : t("billing.recurringNote"),
      icon: Wallet,
    },
    {
      key: "calls",
      label: t("billing.calls"),
      value: report ? nf.format(report.totals.calls) : "—",
      hint: report ? t("billing.answeredOf", { count: nf.format(report.totals.answered) }) : undefined,
      icon: PhoneCall,
    },
    {
      key: "minutes",
      label: t("billing.minutes"),
      value: report ? nf.format(Math.round(report.totals.seconds / 60)) : "—",
      icon: Timer,
    },
  ];

  // Total de la période, toutes sources : voip.ms (réel) + SMS (estimé) + IA (réel).
  // Une source ne compte QUE si elle a répondu POUR LA PÉRIODE affichée : sinon
  // le total mélangerait deux périodes (le CDR voip.ms est lent, la base rapide)
  // ou compterait 0 $ une téléphonie encore en vol — un total qui ment.
  const voipReady = !!report && report.from === from && report.to === to;
  const consReady = !!consumption && consumption.from === from && consumption.to === to;
  const voipCost = voipReady ? report.totals.cost : 0;
  const aiCost = consReady ? consumption.ai.costUsd : 0;
  // Le coût affiché : le réel de Twilio quand on l'a, sinon l'estimation.
  const smsCost = consReady ? consumption.sms.costUsd : 0;
  const totalComplete = voipReady && consReady;
  const grandTotal = voipCost + aiCost + smsCost;

  return (
    <div className="space-y-6">
      {/* ── Période ── */}
      <div className="flex flex-wrap items-end gap-2">
        {PRESETS.map((days) => (
          <Button
            key={days}
            type="button"
            variant={preset === days ? "default" : "outline"}
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={() => applyPreset(days)}
            disabled={loading}
          >
            {t("billing.lastDays", { count: days })}
          </Button>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="billing-from" className="text-xs">
              {t("billing.from")}
            </Label>
            <Input
              id="billing-from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="min-h-11 md:min-h-8"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="billing-to" className="text-xs">
              {t("billing.to")}
            </Label>
            <Input
              id="billing-to"
              type="date"
              value={to}
              min={from}
              max={todayStr()}
              onChange={(e) => setTo(e.target.value)}
              className="min-h-11 md:min-h-8"
            />
          </div>
          <Button
            type="button"
            variant={preset === "custom" ? "default" : "outline"}
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={applyCustom}
            disabled={loading || !rangeValid}
          >
            {t("billing.apply")}
          </Button>
          {rangeDays > MAX_RANGE_DAYS ? (
            <p className="w-full text-xs text-amber-700 dark:text-amber-400">
              {t("billing.rangeTooLong", { days: MAX_RANGE_DAYS })}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-11 md:min-h-8"
          onClick={() => loadAll(from, to)}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t("billing.refresh")}
        </Button>
      </div>

      {/* ── Total de la période, toutes sources ── */}
      <Card className="shadow-xs">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground">{t("billing.grandTotal")}</p>
            {/* Le total ne s'affiche en CHIFFRE que si les trois sources ont
                répondu pour cette période. Sinon « — » : un total partiel
                présenté comme complet serait pris pour la facture. */}
            <p className="text-3xl font-semibold tabular-nums">
              {totalComplete ? money(grandTotal) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {totalComplete ? t("billing.grandTotalNote") : t("billing.totalPartial")}
            </p>
          </div>
          <div className="flex flex-wrap gap-4 text-sm tabular-nums">
            <span>
              <span className="text-muted-foreground">{t("billing.sectionTelephony")} · </span>
              {voipReady ? money(voipCost) : "—"}
            </span>
            <span>
              <span className="text-muted-foreground">{t("billing.sectionSms")} · </span>
              {consReady ? money(smsCost) : "—"}
            </span>
            <span>
              <span className="text-muted-foreground">{t("billing.sectionAi")} · </span>
              {consReady ? money(aiCost) : "—"}
            </span>
          </div>
        </CardContent>
      </Card>

      <h2 className="text-sm font-semibold">{t("billing.sectionTelephony")}</h2>

      {error ? (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
          <p className="text-xs text-muted-foreground">{t("users.voip.ipHint")}</p>
        </div>
      ) : null}

      {/* ── Tuiles ── */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.key} size="sm" className="shadow-xs">
            <CardContent className="space-y-0.5">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-xs text-muted-foreground">{tile.label}</p>
                <tile.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </div>
              <p
                className={cn(
                  "text-2xl font-semibold tabular-nums",
                  tile.tone === "warn" && "text-amber-600 dark:text-amber-400",
                  tile.tone === "accent" && "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {loading && !report ? "…" : tile.value}
              </p>
              {tile.hint ? <p className="truncate text-xs text-muted-foreground">{tile.hint}</p> : null}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ── Par téléphoniste ── */}
      <Card className="shadow-xs">
        <CardContent className="p-0">
          {loading && !report ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </p>
          ) : null}

          {report ? (
            <>
              {/* Desktop */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("billing.user")}</TableHead>
                      <TableHead>{t("billing.number")}</TableHead>
                      <TableHead className="text-right">{t("billing.calls")}</TableHead>
                      <TableHead className="text-right">{t("billing.duration")}</TableHead>
                      <TableHead className="text-right">{t("billing.cost")}</TableHead>
                      <TableHead className="w-0" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.rows.map((row) => (
                      <TableRow key={row.userId ?? "unattributed"}>
                        <TableCell>
                          {row.userId ? (
                            <>
                              <span className="font-medium">{row.name}</span>
                              {row.email ? (
                                <span className="block text-xs text-muted-foreground">{row.email}</span>
                              ) : null}
                            </>
                          ) : (
                            <>
                              <span className="font-medium">{t("billing.unattributed")}</span>
                              <span className="block text-xs text-muted-foreground">
                                {t("billing.unattributedHint")}
                              </span>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {row.didNumber ? formatPhone(row.didNumber) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{nf.format(row.calls)}</TableCell>
                        <TableCell className="text-right tabular-nums">{mmss(row.seconds)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(row.cost)}
                        </TableCell>
                        <TableCell>
                          {row.didNumber ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 md:min-h-8"
                              onClick={() => setCancelTarget(row)}
                            >
                              <PhoneOff className="size-4" />
                              {t("billing.cancelNumber")}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile */}
              <ul className="divide-y md:hidden">
                {report.rows.map((row) => (
                  <li key={row.userId ?? "unattributed"} className="space-y-1.5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">
                        {row.userId ? row.name : t("billing.unattributed")}
                      </span>
                      <span className="tabular-nums font-semibold">{money(row.cost)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("billing.rowSummary", {
                        calls: nf.format(row.calls),
                        duration: mmss(row.seconds),
                      })}
                    </p>
                    {row.didNumber ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{formatPhone(row.didNumber)}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11"
                          onClick={() => setCancelTarget(row)}
                        >
                          <PhoneOff className="size-4" />
                          {t("billing.cancelNumber")}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>

              {/* Le tableau liste tous les téléphonistes actifs : c'est
                  l'ABSENCE d'appels qu'il faut annoncer, pas l'absence de lignes. */}
              {report.totals.calls === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{t("billing.empty")}</p>
              ) : null}

              {/* D'où viennent les chiffres — pour ne jamais les faire passer
                  pour la facture officielle. */}
              <p className="border-t p-3 text-xs text-muted-foreground">{t("billing.costSource")}</p>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ── SMS (Twilio) et Assistants (IA) — depuis la base ── */}
      <ConsumptionSections
        data={consumption}
        loading={consLoading}
        error={consError}
        money={money}
        nf={nf}
        onRateSaved={() => void loadConsumption(from, to)}
      />

      {/* ── Résiliation d'un numéro (irréversible) ── */}
      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(o) => {
          if (o || cancelling) return;
          setCancelTarget(null);
          setConfirmDigits("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("billing.cancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("billing.cancelDesc", {
                number: cancelTarget?.didNumber ? formatPhone(cancelTarget.didNumber) : "",
                name: cancelTarget?.userId ? cancelTarget.name : t("billing.unattributed"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Une frappe volontaire : le clic seul ne doit pas suffire pour un
              geste irréversible. */}
          <div className="space-y-1.5">
            <Label htmlFor="cancel-confirm">
              {t("billing.confirmLabel", { digits: expectedDigits })}
            </Label>
            <Input
              id="cancel-confirm"
              inputMode="numeric"
              autoComplete="off"
              value={confirmDigits}
              onChange={(e) => setConfirmDigits(e.target.value)}
              disabled={cancelling}
              className="min-h-11 font-mono md:min-h-9"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={cancelling || !confirmMatches}
              onClick={(e) => {
                e.preventDefault();
                void cancelNumber();
              }}
            >
              {cancelling ? <Loader2 className="size-4 animate-spin" /> : <PhoneOff className="size-4" />}
              {t("billing.cancelConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
