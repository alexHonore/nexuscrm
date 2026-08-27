"use client";

import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { MegaphoneIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/components/admin/api";
import { ENROLLMENT_STATUS_LOOK, LookIcon } from "@/components/look";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { emitDataChange } from "@/lib/live";
import { APP_TZ } from "./timezone";

/**
 * Campagnes du client — la fiche dit ENFIN à quoi cette personne est
 * inscrite, avec l'assistant qui tiendra la conversation, et permet d'agir
 * sans partir dans l'éditeur de campagne : mettre en pause, reprendre,
 * retirer. Les actions passent par les MÊMES routes que l'éditeur
 * (PATCH /api/campaigns/…/enrollments/… — RBAC admin + audit côté serveur) ;
 * un téléphoniste voit tout, mais n'agit pas.
 */

export type ClientEnrollmentData = {
  id: string;
  campaignId: string;
  campaignName: string;
  /** Statut d'affichage — « paused » est synthétisé côté serveur. */
  displayStatus: string;
  /** Encore vivante (pending/active) : les actions n'ont de sens que là. */
  inFlight: boolean;
  paused: boolean;
  /**
   * Terminée AVANT que les derniers barreaux de la campagne n'existent : elle
   * peut reprendre la suite. Calculé côté serveur — la carte affiche, elle ne
   * refait pas l'arithmétique de l'échelle.
   */
  reopenable: boolean;
  /** Barreaux déjà partis / longueur de l'échelle. */
  sent: number;
  total: number;
  nextTouchAt: string | null; // ISO
  enrolledAt: string; // ISO
  endReason: string | null;
  assistantName: string | null;
};

/** Le mot juste après chaque geste — la cascade de ternaires en oubliait un. */
const TOAST_KEY = {
  pause: "paused",
  resume: "resumed",
  remove: "removed",
  reopen: "reopenedOne",
} as const;

export function CampaignEnrollmentsCard({
  clientName,
  isAdmin,
  enrollments,
}: {
  clientName: string;
  isAdmin: boolean;
  enrollments: ClientEnrollmentData[];
}) {
  const t = useTranslations("clients");
  const tc = useTranslations("campaigns");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  const fmt = (iso: string) =>
    formatInTimeZone(new Date(iso), APP_TZ, "EEE d MMM, HH:mm", { locale: dfnsLocale });

  const act = async (
    e: ClientEnrollmentData,
    action: "pause" | "resume" | "remove" | "reopen",
  ) => {
    if (
      action === "remove" &&
      !window.confirm(tc("editor.enrollments.removeConfirm", { name: clientName }))
    )
      return;
    setBusyId(e.id);
    try {
      await api(`/api/campaigns/${e.campaignId}/enrollments/${e.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      });
      toast.success(tc(`editor.enrollments.toast.${TOAST_KEY[action]}` as never));
      emitDataChange("sms");
      router.refresh();
    } catch (err) {
      // Deux familles de motifs, et cette carte rencontre surtout la seconde :
      // ce qui écarte CETTE inscription (`reopenRefusal`), et ce qui bloque
      // toute la campagne (`reopenError` — campagne en pause, fenêtre fermée,
      // aucun numéro d'envoi). La fiche client affiche le bouton sans rien
      // savoir de l'état de la campagne ; lui répondre « action impossible »
      // ne laisserait rien à corriger.
      const code = err instanceof ApiError ? err.code : "";
      const named = ["reopenRefusal", "reopenError"]
        .map((group) => `editor.enrollments.${group}.${code}`)
        .find((key) => tc.has(key as never));
      toast.error(
        action === "reopen" && named !== undefined
          ? tc(named as never)
          : tc("editor.enrollments.toast.failed"),
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MegaphoneIcon aria-hidden className="size-4 text-muted-foreground" />
          {t("campaigns.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {enrollments.map((e) => {
            const look = ENROLLMENT_STATUS_LOOK[e.displayStatus] ?? ENROLLMENT_STATUS_LOOK.pending;
            const statusLabel = tc(`editor.enrollments.status.${e.displayStatus}` as never);
            const endReasonKey = `editor.enrollments.endReason.${e.endReason ?? ""}`;
            return (
              <li key={e.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <LookIcon look={look} size="sm" />
                      {isAdmin ? (
                        <Link
                          href={`/admin/campaigns/${e.campaignId}`}
                          className="truncate font-medium hover:underline"
                          title={t("campaigns.open")}
                        >
                          {e.campaignName}
                        </Link>
                      ) : (
                        <span className="truncate font-medium">{e.campaignName}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span style={{ color: look.color }} className="font-medium">
                        {statusLabel}
                      </span>
                      {" · "}
                      {t("campaigns.progress", { sent: e.sent, total: e.total })}
                      {e.assistantName ? (
                        <>
                          {" · "}
                          {t("campaigns.assistant", { name: e.assistantName })}
                        </>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {e.inFlight && !e.paused && e.nextTouchAt
                        ? t("campaigns.nextTouch", { when: fmt(e.nextTouchAt) })
                        : null}
                      {!e.inFlight && e.endReason && tc.has(endReasonKey as never)
                        ? tc(endReasonKey as never)
                        : null}
                    </p>
                  </div>
                  {isAdmin && e.inFlight ? (
                    <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
                      {e.paused ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11 md:min-h-8"
                          disabled={busyId === e.id}
                          onClick={() => act(e, "resume")}
                        >
                          {tc("editor.enrollments.resume")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11 md:min-h-8"
                          disabled={busyId === e.id}
                          onClick={() => act(e, "pause")}
                        >
                          {tc("editor.enrollments.pause")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-11 text-destructive hover:text-destructive md:min-h-8"
                        disabled={busyId === e.id}
                        onClick={() => act(e, "remove")}
                      >
                        {tc("editor.enrollments.remove")}
                      </Button>
                    </div>
                  ) : isAdmin && e.reopenable ? (
                    // « Terminée · 1/3 messages envoyés » se lisait déjà ici :
                    // l'échelle a grandi, cette fiche n'a jamais reçu la suite.
                    // Le bouton est la réponse à ce que la carte annonce déjà.
                    <div className="shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11 md:min-h-8"
                        disabled={busyId === e.id}
                        onClick={() => act(e, "reopen")}
                      >
                        {tc("editor.enrollments.reopen")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
