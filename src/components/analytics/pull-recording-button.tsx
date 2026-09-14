"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type PullStatus = "attached" | "already" | "not_found" | "no_line" | "upstream_error";

/**
 * « Rien de rattaché » se dit de trois façons : voip.ms n'a encore rien sur la
 * ligne, il a des enregistrements dont aucun n'est celui de cet appel, ou
 * l'appel n'est pas passé par lui (voir `PullNotFoundReason`).
 */
const NOT_FOUND_MESSAGE = {
  pending: "callsPage.pullPending",
  unmatched: "callsPage.pullUnmatched",
  not_voipms: "callsPage.pullNotVoipms",
} as const;
type NotFoundReason = keyof typeof NOT_FOUND_MESSAGE;

/**
 * « Récupérer » : l'enregistrement d'UN appel, demandé à voip.ms tout de
 * suite — pour l'appel de ce matin qu'on veut écouter maintenant, sans lancer
 * la synchronisation de toute la journée de tous les postes.
 *
 * Même pictogramme que « Synchroniser voip.ms » : c'est la même question posée
 * à voip.ms, pour un seul appel. Le bouton n'est offert que là où un
 * enregistrement PEUT exister (voir `CallRow.canPullRecording`) ; « pas
 * encore » reste une réponse normale, voip.ms dépose souvent l'audio quelques
 * minutes après la fin de l'appel.
 */
export function PullRecordingButton({ callId, compact }: { callId: string; compact?: boolean }) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const pull = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/calls/${callId}/recording`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        status?: PullStatus;
        reason?: NotFoundReason;
      } | null;
      const status = res.ok ? data?.status : undefined;
      if (status === "attached" || status === "already") {
        toast.success(t("callsPage.pullAttached"));
        router.refresh();
      } else if (status === "not_found") {
        const reason = data?.reason && data.reason in NOT_FOUND_MESSAGE ? data.reason : "pending";
        toast.info(t(NOT_FOUND_MESSAGE[reason]));
      } else if (status === "no_line") {
        toast.warning(t("callsPage.pullNoLine"));
      } else {
        toast.error(t("callsPage.pullFailed"));
      }
    } catch {
      toast.error(t("callsPage.pullFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={compact ? "h-11 w-full" : "h-8"}
      title={t("callsPage.pullTitle")}
      disabled={busy}
      onClick={() => void pull()}
    >
      <RefreshCw aria-hidden className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
      {busy ? t("callsPage.pullRunning") : t("callsPage.pullRecording")}
    </Button>
  );
}
