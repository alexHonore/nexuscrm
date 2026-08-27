"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { ApiError, api } from "../api";

/**
 * « Relancer les terminées » — le geste qui rattrape les inscriptions closes
 * avant que les derniers barreaux n'existent.
 *
 * Il s'ouvre sur un APERÇU, jamais sur une action : le clic demande d'abord au
 * serveur combien repartiraient, quand le premier et le dernier message
 * partiraient, et qui est écarté pour quel motif. Rien n'est écrit tant que la
 * confirmation n'a pas été donnée, et l'aperçu emprunte exactement le même
 * chemin que le geste réel — un aperçu qui compterait autrement mentirait.
 *
 * Pourquoi l'aperçu compte : la relance programme de VRAIS SMS, à de vraies
 * personnes, dont certaines n'ont plus rien à voir avec la campagne depuis des
 * mois. Le chiffre affiché est celui qui engage.
 */

/** Motifs connus — seuls ceux-là ont une étiquette traduite. */
const REFUSALS = new Set([
  "not_found",
  "not_closed",
  "not_ladder_end",
  "nothing_new",
  "no_phone",
  "suppressed",
  "do_not_call",
  "replied_since",
  "live_conversation",
  "ai_paused",
  "left_audience",
  "assistant_inactive",
  "conflict",
]);

/** Refus de campagne — ils abattent le geste entier et ont chacun leur phrase. */
const GATE_ERRORS = new Set([
  "kill_switch",
  "campaign_not_active",
  "outside_window",
  "empty_ladder",
  "no_sender",
]);

type ReopenResponse = {
  dryRun: boolean;
  candidates: number;
  reopened: number;
  refused: Record<string, number>;
  remaining: number;
  firstAt: string | null;
  lastAt: string | null;
};

export function ReopenDialog({
  campaignId,
  count,
  dirty,
  onDone,
  size = "default",
}: {
  campaignId: string;
  /** Candidats connus au chargement — sert à libeller le bouton. */
  count: number;
  /** L'échelle a des modifications non enregistrées. */
  dirty: boolean;
  onDone: () => void;
  size?: "default" | "sm";
}) {
  const t = useTranslations("campaigns");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ReopenResponse | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const when = (iso: string) =>
    new Date(iso).toLocaleString(locale === "en" ? "en-CA" : "fr-CA", {
      timeZone: "America/Toronto",
      dateStyle: "medium",
      timeStyle: "short",
    });

  const call = async (dryRun: boolean) =>
    api<ReopenResponse>(`/api/campaigns/${campaignId}/reopen`, {
      method: "POST",
      body: JSON.stringify({ dryRun }),
    });

  const openDialog = async () => {
    setOpen(true);
    setPreview(null);
    setGateError(null);
    setBusy(true);
    try {
      setPreview(await call(true));
    } catch (err) {
      // Un refus de campagne n'est PAS une panne : il se lit, et il dit quoi
      // corriger — numéro éteint, campagne en pause, assistant non compilé.
      const code = err instanceof ApiError ? err.code : "";
      if (GATE_ERRORS.has(code)) setGateError(code);
      else toast.error(t("editor.enrollments.toast.failed"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await call(false);
      toast.success(t("editor.enrollments.toast.reopened", { count: result.reopened }));
      setOpen(false);
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      if (GATE_ERRORS.has(code)) setGateError(code);
      else toast.error(t("editor.enrollments.toast.failed"));
    } finally {
      setBusy(false);
    }
  };

  const breakdown = Object.entries(preview?.refused ?? {})
    .filter(([code, n]) => n > 0 && REFUSALS.has(code))
    .map(([code, n]) =>
      t("editor.enrollments.refusalCount", {
        label: t(`editor.enrollments.reopenRefusal.${code}` as never),
        count: n,
      }),
    );

  return (
    <>
      <Button
        variant="outline"
        size={size}
        className="min-h-11 md:min-h-9"
        // Une échelle non enregistrée promettrait des barreaux qui n'existent
        // pas encore côté serveur : la relance partirait sur l'ancienne.
        disabled={dirty || busy}
        title={dirty ? t("editor.enrollments.reopenDirty") : undefined}
        onClick={() => void openDialog()}
      >
        <RotateCcw />
        {t("editor.enrollments.reopenAll", { count })}
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => !next && !busy && setOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("editor.enrollments.reopenTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gateError !== null
                ? t(`editor.enrollments.reopenError.${gateError}` as never)
                : preview === null
                  ? t("editor.enrollments.reopenChecking")
                  : preview.candidates === 0
                    ? t("editor.enrollments.reopenNone")
                    : t("editor.enrollments.reopenBody", { count: preview.candidates })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Le détail des refus reste affiché MÊME quand plus rien ne part :
              c'est précisément là qu'il répond à la seule question qui compte,
              « pourquoi zéro ? ». Seules les dates d'envoi disparaissent —
              elles n'ont plus d'objet. */}
          {gateError === null && preview !== null ? (
            <div className="space-y-1.5 text-sm text-muted-foreground">
              {preview.candidates > 0 ? (
                <>
                  {preview.firstAt && preview.lastAt ? (
                    <p>
                      {t("editor.enrollments.reopenWindow", {
                        first: when(preview.firstAt),
                        last: when(preview.lastAt),
                      })}
                    </p>
                  ) : null}
                  <p>{t("editor.enrollments.reopenSpread")}</p>
                </>
              ) : null}
              {breakdown.length > 0 ? <p>{breakdown.join(" · ")}</p> : null}
              {preview.remaining > 0 ? (
                <p>{t("editor.enrollments.reopenRemaining", { count: preview.remaining })}</p>
              ) : null}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirm()}
              disabled={busy || gateError !== null || (preview?.candidates ?? 0) === 0}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {t("editor.enrollments.reopenConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
