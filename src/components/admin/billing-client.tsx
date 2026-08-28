"use client";

import {
  Bot,
  Loader2,
  MessageSquare,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  Timer,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { listDays, shiftDateStr, todayStr } from "@/components/analytics/period";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { BalanceTiles, type BalanceTile } from "./billing-balances";
import {
  RankedBarChart,
  SOURCE_VAR,
  SPEND_SOURCES,
  SpendPerDayChart,
  SpendShareBar,
  type SpendDayDatum,
  type SpendSource,
} from "./billing-charts";
import { ConsumptionSections, type ConsumptionReport } from "./consumption-sections";
import { errorMessage } from "./errors";

/**
 * Tableau de bord de la dépense : ce que la période a coûté, où c'est parti,
 * et ce qu'il reste sur les trois comptes prépayés.
 *
 * La page répond dans cet ordre, parce que c'est celui des questions qu'on se
 * pose en regardant son téléphone entre deux appels :
 *
 *  1. **Combien** — un seul grand chiffre, et une barre qui montre la part de
 *     chaque source ;
 *  2. **Est-ce que je tombe en panne** — les soldes voip.ms, Twilio et
 *     OpenRouter, avec leur autonomie estimée ;
 *  3. **Quand est-ce parti** — une pile par journée, quatre sources ;
 *  4. le détail par source, sous le pli.
 *
 * Les montants affichés viennent des fournisseurs (CDR voip.ms, Usage Records
 * Twilio, traces OpenRouter). Rien n'est recalculé à partir de la durée ni des
 * segments quand le vrai chiffre existe : un prix estimé ressemblerait à une
 * facture sans en être une, et c'est précisément l'erreur qu'une page d'argent
 * ne doit pas faire.
 */

/**
 * Le CDR d'une longue période met du temps à revenir. Reste SOUS le budget du
 * serveur (`maxDuration = 120`) pour que l'admin voie un message clair plutôt
 * qu'une erreur de plateforme.
 */
const REPORT_TIMEOUT_MS = 110_000;

/** Le CDR voip.ms devient trop lent au-delà d'un mois — même borne que le serveur. */
const MAX_RANGE_DAYS = 31;

const PRESETS = [7, 30] as const;

/**
 * Sous ce solde, chaque compte est annoncé « bas ».
 *
 * Trois seuils, parce que trois échelles : un achat de numéro voip.ms se
 * compte en dizaines de dollars, un lot de SMS en unités, et un crédit
 * OpenRouter s'épuise en quelques journées d'assistant.
 */
const LOW_BALANCE = { voipms: 25, twilio: 20, openrouter: 10 } as const;

/** Deux semaines COMPLÈTES à comparer — la journée en cours ne compte pas. */
const TREND_MIN_DAYS = 14;

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

type UsageDay = {
  date: string;
  calls: number;
  answered: number;
  seconds: number;
  cost: number;
};

type UsageReport = {
  from: string;
  to: string;
  rows: UsageRow[];
  daily: UsageDay[];
  totals: { calls: number; answered: number; seconds: number; cost: number };
  balance: {
    currentBalance: number | null;
    spentTotal: number | null;
    callsTotal: number | null;
    timeTotal: number | null;
  } | null;
  costUnavailable: boolean;
};

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
  // ailleurs dans l'app : voip.ms et Twilio facturent en dollars AMÉRICAINS, et
  // un symbole « $ » seul se lirait comme des dollars canadiens au Québec.
  const amountFmt = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const money = (n: number | null) => (n === null ? "—" : amountFmt.format(n));
  /**
   * Les GRADUATIONS d'un axe d'argent : jusqu'à quatre décimales, et aucune
   * imposée. Deux décimales fixes donnent « 0,00 » cinq fois de suite sur une
   * période à quelques centimes, et « 4,00 » là où « 4 » suffit.
   */
  const axisFmt = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
  const moneyAxis = (n: number) => axisFmt.format(n);
  const nf = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA");
  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }),
    [locale],
  );
  /** Une date « YYYY-MM-DD » lue à midi UTC : jamais de glissement de veille. */
  const dayLabel = useCallback(
    (date: string) => dayFmt.format(new Date(`${date}T12:00:00Z`)),
    [dayFmt],
  );

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

  // ── Ce qui a répondu, POUR CETTE PÉRIODE ───────────────────────────────────
  // Une source ne compte QUE si elle a répondu pour la période AFFICHÉE : sinon
  // le total mélangerait deux périodes (le CDR voip.ms est lent, la base
  // rapide) ou compterait 0 $ une téléphonie encore en vol — un total qui ment.
  const voipReady = !!report && report.from === from && report.to === to;
  const consReady = !!consumption && consumption.from === from && consumption.to === to;

  const smsDailyCost = consReady ? consumption.sms.dailyCost : null;

  /**
   * Le montant de chaque source, ou `null` quand on ne le CONNAÎT pas.
   *
   * `null` n'est pas « zéro » : c'est ce qui interdit au total de se présenter
   * comme complet, et à la barre de répartition d'afficher des pourcentages
   * calculés contre un tout amputé.
   *
   *  · **Téléphonie** — connue quand voip.ms a répondu POUR CETTE PÉRIODE *et*
   *    a chiffré les appels. Un CDR revenu sans aucun montant (`costUnavailable`)
   *    n'est pas une période à 0 $, c'est une période inconnue.
   *  · **SMS** — la somme des journées facturées quand on les a (frais de
   *    transporteur compris, donc le MÊME chiffre que le graphique). Sinon le
   *    coût de la période : l'estimation par segments couvre tout le trafic par
   *    construction, mais un coût RÉEL amputé de frais qu'on n'a pas mesurés est
   *    un chiffre dont on sait qu'il est court — il ne s'affiche pas.
   *  · **IA et notes d'appel** — connues dès que la base a répondu.
   */
  const voipCost = voipReady && !report.costUnavailable ? report.totals.cost : null;
  const smsCost = !consReady
    ? null
    : smsDailyCost
      ? smsDailyCost.reduce((acc, d) => acc + d.costUsd, 0)
      : consumption.sms.costSource === "estimate"
        ? consumption.sms.costUsd
        : consumption.sms.carrierFeesUsd === null
          ? null
          : consumption.sms.costUsd + consumption.sms.carrierFeesUsd;
  const aiCost = consReady ? consumption.ai.costUsd : null;
  const transcriptsCost = consReady ? consumption.transcripts.costUsd : null;

  const amounts: Record<SpendSource, number | null> = {
    sms: smsCost,
    telephony: voipCost,
    ai: aiCost,
    notes: transcriptsCost,
  };
  const totalComplete = SPEND_SOURCES.every((key) => amounts[key] !== null);
  const grandTotal = totalComplete
    ? SPEND_SOURCES.reduce((acc, key) => acc + (amounts[key] ?? 0), 0)
    : null;
  const dayCount = listDays(from, to).length;

  const sourceLabels: Record<SpendSource, string> = {
    sms: t("billing.sectionSms"),
    telephony: t("billing.sectionTelephony"),
    ai: t("billing.sectionAi"),
    notes: t("billing.sectionTranscripts"),
  };

  // ── La pile par journée ────────────────────────────────────────────────────
  // Chaque source est dessinée SEULEMENT si elle a répondu : une bande plate à
  // zéro annoncerait « aucune dépense » là où on ne sait rien.
  const hasTelephony = voipCost !== null;
  // Le graphique a besoin du DÉTAIL par journée, pas seulement du total.
  const hasSms = !!smsDailyCost;
  const available: Record<SpendSource, boolean> = {
    telephony: hasTelephony,
    sms: hasSms,
    ai: consReady,
    notes: consReady,
  };
  const allSources = hasTelephony && hasSms && consReady;

  const spendDays: SpendDayDatum[] = useMemo(() => {
    const days = listDays(from, to);
    const voipByDay = new Map((voipReady ? report.daily : []).map((d) => [d.date, d.cost]));
    const smsByDay = new Map((smsDailyCost ?? []).map((d) => [d.date, d.costUsd]));
    const aiByDay = new Map((consReady ? consumption.ai.daily : []).map((d) => [d.date, d.costUsd]));
    const notesByDay = new Map(
      (consReady ? consumption.transcripts.daily : []).map((d) => [d.date, d.costUsd]),
    );

    const rows = days.map((date) => {
      const telephony = hasTelephony ? (voipByDay.get(date) ?? 0) : 0;
      const sms = hasSms ? (smsByDay.get(date) ?? 0) : 0;
      const ai = consReady ? (aiByDay.get(date) ?? 0) : 0;
      const notes = consReady ? (notesByDay.get(date) ?? 0) : 0;
      return {
        key: date,
        label: dayLabel(date),
        sms,
        telephony,
        ai,
        notes,
        total: sms + telephony + ai + notes,
        peakLabel: "",
      };
    });

    // Étiquetage SÉLECTIF : uniquement la journée la plus chère, et seulement
    // si toutes les sources ont répondu — sinon l'étiquette annoncerait un
    // « pire jour » calculé sur une pile incomplète.
    if (allSources) {
      let peak = -1;
      rows.forEach((r, i) => {
        if (r.total > 0 && (peak === -1 || r.total > rows[peak].total)) peak = i;
      });
      if (peak >= 0) rows[peak] = { ...rows[peak], peakLabel: money(rows[peak].total) };
    }
    return rows;
    // `money` et `report`/`consumption` sont des valeurs, pas des identités
    // stables : les dépendances listées sont celles dont la SORTIE dépend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    from,
    to,
    report,
    consumption,
    hasTelephony,
    hasSms,
    consReady,
    voipReady,
    allSources,
    smsDailyCost,
    dayLabel,
  ]);

  /**
   * Sept derniers jours contre les sept précédents.
   *
   * Le seul signal de DÉRIVE de la page, et il ne coûte ni pixel ni clic — il
   * se calcule sur les journées déjà chargées. Absent sous deux semaines (il
   * n'y aurait pas deux semaines à comparer) et absent dès qu'une source
   * manque, pour la même raison que le total : comparer deux moitiés dont l'une
   * est incomplète produit une variation inventée.
   */
  const trend = useMemo(() => {
    if (!allSources) return null;
    // La journée EN COURS n'est pas finie : la compter face à sept journées
    // complètes fabriquerait une baisse tous les matins. On s'arrête donc à
    // hier dès que la période va jusqu'à aujourd'hui.
    const end = to === todayStr() ? spendDays.length - 1 : spendDays.length;
    if (end < TREND_MIN_DAYS) return null;
    const last7 = spendDays.slice(end - 7, end).reduce((a, d) => a + d.total, 0);
    const prev7 = spendDays.slice(end - 14, end - 7).reduce((a, d) => a + d.total, 0);
    if (prev7 <= 0) return null;
    return { pct: Math.round(((last7 - prev7) / prev7) * 100) };
  }, [spendDays, to, allSources]);

  /** Coût par téléphoniste — série nominale unique, masquée sous deux barres. */
  const perCaller = (voipReady ? report.rows : []).map((row) => ({
    key: row.userId ?? "unattributed",
    label: row.userId ? row.name : t("billing.unattributed"),
    value: row.cost,
  }));

  const balanceTiles: BalanceTile[] = [
    {
      key: "voipms",
      label: t("billing.tankVoipms"),
      Icon: PhoneCall,
      balance: voipReady ? (report.balance?.currentBalance ?? null) : null,
      periodCost: voipCost,
      lowBelow: LOW_BALANCE.voipms,
    },
    {
      key: "twilio",
      label: t("billing.tankTwilio"),
      Icon: MessageSquare,
      balance: consReady ? (consumption.sms.balance?.balanceUsd ?? null) : null,
      // L'autonomie ne se calcule QUE sur une dépense réelle : divisée par une
      // estimation, elle deviendrait une prédiction fondée sur une supposition.
      periodCost: smsDailyCost ? smsDailyCost.reduce((acc, d) => acc + d.costUsd, 0) : null,
      lowBelow: LOW_BALANCE.twilio,
    },
    {
      key: "openrouter",
      label: t("billing.tankOpenrouter"),
      Icon: Bot,
      // Crédits achetés moins dépense à VIE : c'est bien « ce qu'il reste »,
      // pas une part d'un plafond — d'où une tuile de chiffre et jamais une
      // jauge, dont le dénominateur ne mesurerait que l'âge du compte.
      balance:
        consReady && consumption.ai.account
          ? Math.max(0, consumption.ai.account.totalCreditsUsd - consumption.ai.account.totalUsageUsd)
          : null,
      periodCost: aiCost !== null && transcriptsCost !== null ? aiCost + transcriptsCost : null,
      lowBelow: LOW_BALANCE.openrouter,
    },
  ];

  /**
   * Le rapport voip.ms à AFFICHER dans la section téléphonie.
   *
   * Tant qu'un chargement est en cours, on garde le précédent en retrait — un
   * « — » clignotant à chaque clic serait pire. Mais un chargement TERMINÉ qui
   * n'a pas rendu la période demandée (échec voip.ms) ne doit surtout pas
   * laisser les chiffres du mois dernier sous le titre du mois en cours : là,
   * c'est « — », et la bannière d'erreur juste au-dessus dit pourquoi.
   */
  const shownReport = voipReady || loading ? report : null;
  const stale = loading && !!report;

  const tiles: {
    key: string;
    label: string;
    value: string;
    hint?: string;
    icon: typeof Wallet;
  }[] = [
    {
      key: "cost",
      label: t("billing.periodCost"),
      value:
        shownReport && !shownReport.costUnavailable ? money(shownReport.totals.cost) : "—",
      // La location mensuelle des numéros n'est PAS dans le CDR : le dire ici
      // évite de laisser croire que résilier un numéro fera bouger ce chiffre.
      hint: shownReport?.costUnavailable
        ? t("billing.costUnavailable")
        : t("billing.recurringNote"),
      icon: Wallet,
    },
    {
      key: "calls",
      label: t("billing.calls"),
      value: shownReport ? nf.format(shownReport.totals.calls) : "—",
      hint: shownReport
        ? t("billing.answeredOf", { count: nf.format(shownReport.totals.answered) })
        : undefined,
      icon: PhoneCall,
    },
    {
      key: "minutes",
      label: t("billing.minutes"),
      value: shownReport ? nf.format(Math.round(shownReport.totals.seconds / 60)) : "—",
      icon: Timer,
    },
    {
      key: "perMinute",
      label: t("billing.costPerMinute"),
      value:
        shownReport && shownReport.totals.seconds > 0 && !shownReport.costUnavailable
          ? money(shownReport.totals.cost / (shownReport.totals.seconds / 60))
          : "—",
      icon: Timer,
    },
  ];

  return (
    <div className="space-y-6">
      {/* ── Période : LA barre de filtre, au-dessus de tout ce qu'elle cadre ── */}
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
        {/* La plage sur mesure est REPLIÉE tant qu'on ne la demande pas : deux
            champs de date coûtent ~80px de téléphone à qui n'en a pas besoin. */}
        <Button
          type="button"
          variant={preset === "custom" ? "default" : "outline"}
          size="sm"
          className="min-h-11 md:min-h-8"
          onClick={() => setPreset("custom")}
          disabled={loading}
        >
          {t("billing.customRange")}
        </Button>
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

        {preset === "custom" ? (
          <div className="flex w-full flex-wrap items-end gap-2">
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
        ) : null}
      </div>

      {/* ── 1. Combien, et où est-ce parti ─────────────────────────────────── */}
      <Card className="shadow-xs">
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div>
              <p className="text-xs text-muted-foreground">{t("billing.grandTotal")}</p>
              {/* Le total ne s'affiche en CHIFFRE que si toutes les sources ont
                  répondu pour cette période. Sinon « — » : un total partiel
                  présenté comme complet serait pris pour la facture. */}
              <p className="text-4xl font-semibold">{money(grandTotal)}</p>
            </div>
            {grandTotal !== null ? (
              <p className="text-sm text-muted-foreground tabular-nums">
                {t("billing.perDay", { amount: money(grandTotal / Math.max(1, dayCount)) })}
              </p>
            ) : null}
          </div>

          <SpendShareBar
            money={money}
            complete={totalComplete}
            data={SPEND_SOURCES.map((key) => ({
              key,
              label: sourceLabels[key],
              amount: amounts[key],
            }))}
          />

          <p className="text-xs text-muted-foreground">
            {totalComplete ? t("billing.grandTotalNote") : t("billing.totalPartial")}
          </p>
        </CardContent>
      </Card>

      {/* ── 2. Les réservoirs ──────────────────────────────────────────────── */}
      <BalanceTiles
        tiles={balanceTiles}
        dayCount={dayCount}
        money={money}
        loading={loading || consLoading}
      />

      {/* ── 3. Quand est-ce parti ──────────────────────────────────────────── */}
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>{t("billing.perDayTitle")}</CardTitle>
          {trend ? (
            <p
              className={cn(
                "flex items-center gap-1 text-xs",
                // Une semaine STABLE n'est ni une bonne ni une mauvaise
                // nouvelle : elle reste en encre neutre, sans flèche.
                trend.pct === 0
                  ? "text-muted-foreground"
                  : trend.pct > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-emerald-600 dark:text-emerald-400",
              )}
            >
              {trend.pct === 0 ? null : trend.pct > 0 ? (
                <TrendingUp aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <TrendingDown aria-hidden className="size-3.5 shrink-0" />
              )}
              {t("billing.trend7", { pct: `${trend.pct > 0 ? "+" : ""}${trend.pct}` })}
            </p>
          ) : null}
        </CardHeader>
        <CardContent
          className={cn("space-y-3", (loading || consLoading) && "opacity-60 transition-opacity")}
        >
          <SpendPerDayChart
            data={spendDays}
            labels={sourceLabels}
            available={available}
            money={money}
            moneyAxis={moneyAxis}
            totals={amounts}
          />

          {/* Le JUMEAU TABULAIRE du graphique : chaque valeur reste lisible sans
              survol, au clavier comme à l'impression. */}
          <details className="group">
            {/* Cible tactile : ce résumé est le SEUL chemin vers les valeurs
                sans survol, il ne peut pas être une ligne de texte de 16px. */}
            <summary className="flex min-h-11 cursor-pointer list-none items-center text-xs text-muted-foreground underline-offset-2 hover:underline md:min-h-8">
              {t("billing.showDayTable")}
            </summary>
            <div className="mt-2 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 bg-card">{t("billing.day")}</TableHead>
                    {SPEND_SOURCES.map((s) => (
                      <TableHead key={s} className="text-right">
                        {sourceLabels[s]}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">{t("billing.total")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spendDays.map((d) => (
                    <TableRow key={d.key}>
                      <TableCell className="sticky left-0 z-10 bg-card whitespace-nowrap">
                        {d.label}
                      </TableCell>
                      {SPEND_SOURCES.map((s) => (
                        <TableCell key={s} className="text-right tabular-nums">
                          {available[s] ? money(d[s]) : "—"}
                        </TableCell>
                      ))}
                      {/* Un total de ligne calculé sur trois sources sur quatre
                          se lirait comme la dépense du jour. Tant qu'une source
                          manque, la colonne dit « — ». */}
                      <TableCell className="text-right font-medium tabular-nums">
                        {allSources ? money(d.total) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </details>

          {available.sms ? (
            <p className="text-xs text-muted-foreground">{t("billing.utcDayNote")}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── 4. Téléphonie (voip.ms) ────────────────────────────────────────── */}
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

      {/* Pendant un rechargement, les chiffres de la période PRÉCÉDENTE restent
          affichés en retrait — plutôt qu'un « — » clignotant à chaque clic. Le
          grand total, lui, ne bouge pas tant que les sources ne concordent pas. */}
      <section
        className={cn(
          "grid grid-cols-2 gap-3 md:grid-cols-4",
          stale && "opacity-60 transition-opacity",
        )}
      >
        {tiles.map((tile) => (
          <Card key={tile.key} size="sm" className="shadow-xs">
            <CardContent className="space-y-0.5">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-xs text-muted-foreground">{tile.label}</p>
                <tile.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold">{loading && !report ? "…" : tile.value}</p>
              {tile.hint ? <p className="truncate text-xs text-muted-foreground">{tile.hint}</p> : null}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* Coût par téléphoniste — absent sous deux barres : une valeur seule est
          une tuile de chiffre, pas un graphique. Le tableau, lui, reste. */}
      {hasTelephony && perCaller.filter((r) => r.value > 0).length >= 2 ? (
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle>{t("billing.perCallerTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <RankedBarChart
              data={perCaller}
              color={SOURCE_VAR.telephony}
              format={(n) => money(n)}
              formatAxis={moneyAxis}
              seriesName={t("billing.cost")}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* ── Par téléphoniste ── */}
      <Card className={cn("shadow-xs", stale && "opacity-60 transition-opacity")}>
        <CardContent className="p-0">
          {loading && !report ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </p>
          ) : null}

          {shownReport ? (
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
                      <TableHead className="text-right">{t("billing.share")}</TableHead>
                      <TableHead className="w-0" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shownReport.rows.map((row) => (
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
                        {/* Un pourcentage en TEXTE, pas une barre dans la cellule :
                            la colonne voisine dit déjà le montant. */}
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {shownReport.totals.cost > 0 && !shownReport.costUnavailable
                            ? `${Math.round((row.cost / shownReport.totals.cost) * 100)} %`
                            : "—"}
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
                {shownReport.rows.map((row) => (
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
              {shownReport.totals.calls === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{t("billing.empty")}</p>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ── 5. SMS (Twilio) et IA — depuis la base ─────────────────────────── */}
      <ConsumptionSections
        data={consumption}
        loading={consLoading}
        error={consError}
        money={money}
        moneyAxis={moneyAxis}
        nf={nf}
        dayLabel={dayLabel}
        onRateSaved={() => void loadConsumption(from, to)}
      />

      {/* ── 6. D'où viennent ces chiffres ──────────────────────────────────── */}
      <section className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <h2 className="font-semibold text-foreground">{t("billing.provenanceTitle")}</h2>
        <p>{t("billing.costSource")}</p>
        <p>{t("billing.recurringNote")}</p>
        <p>{t("billing.utcDayNote")}</p>
        <p>{t("billing.carrierFeesNote")}</p>
        <p>{t("billing.aiAccountNote")}</p>
        <p>{t("billing.balancesNote")}</p>
      </section>

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
