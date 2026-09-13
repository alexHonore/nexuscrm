"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { formatSize } from "@/components/analytics/format-size";
import { LIBRARY_LOOK, LookGlyph } from "@/components/look";
import { Button } from "@/components/ui/button";

/** La copie de l'audio d'un appel, gardée dans la base (voir `recording_audio`). */
export type KeptAudio = { state: "kept"; bytes: number } | { state: "removed" } | { state: "none" };

type KeepStatus =
  | "kept"
  | "already"
  | "removed"
  | "cap_reached"
  | "not_in_library"
  | "no_recording"
  | "upstream_error";

/**
 * Où en est la copie de CET appel, et le geste pour la changer.
 *
 * Gardée : elle s'écoute tout de suite, même quand voip.ms ne l'a plus —
 * « Retirer l'audio » rend sa place. Retirée ou pas encore gardée : l'écoute
 * passe par voip.ms — « Conserver l'audio » la reprend. Le bouton n'est offert
 * qu'à qui peut ranger : la copie occupe une place partagée par toute l'équipe.
 */
export function KeptAudioControl({
  callId,
  audio,
  canCurate,
}: {
  callId: string;
  audio: KeptAudio;
  canCurate: boolean;
}) {
  const t = useTranslations("analytics");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const act = async (method: "POST" | "DELETE") => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/recordings/audio", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId }),
      });
      if (method === "DELETE") {
        if (res.ok) {
          toast.success(t("library.audioRemovedToast"));
          router.refresh();
        } else {
          toast.error(t("library.genericError"));
        }
        return;
      }
      const data = (await res.json().catch(() => null)) as { status?: KeepStatus } | null;
      const status = res.ok ? data?.status : res.status === 502 ? "upstream_error" : undefined;
      if (status === "kept") {
        toast.success(t("library.audioKeptToast"));
        router.refresh();
      } else if (status === "already") {
        toast.info(t("library.audioAlready"));
        router.refresh();
      } else if (status === "cap_reached") {
        toast.warning(t("library.audioCapReached"));
      } else if (status === "no_recording") {
        toast.info(t("library.audioNoRecording"));
      } else if (status === "upstream_error") {
        toast.error(t("library.audioUpstream"));
      } else {
        toast.error(t("library.genericError"));
      }
    } catch {
      toast.error(t("library.genericError"));
    } finally {
      setBusy(false);
    }
  };

  const label =
    audio.state === "kept"
      ? t("library.audioKept", { size: formatSize(audio.bytes, locale) })
      : audio.state === "removed"
        ? t("library.audioRemoved")
        : t("library.audioNotKept");

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <LookGlyph
          look={LIBRARY_LOOK.kept}
          className={audio.state === "kept" ? "size-3.5" : "size-3.5 opacity-40"}
        />
        <span>{label}</span>
      </span>
      {canCurate ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 md:h-8"
          disabled={busy}
          onClick={() => void act(audio.state === "kept" ? "DELETE" : "POST")}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {audio.state === "kept" ? t("library.removeAudio") : t("library.keepAudio")}
        </Button>
      ) : null}
    </div>
  );
}
