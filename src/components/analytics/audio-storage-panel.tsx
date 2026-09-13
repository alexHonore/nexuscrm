"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { formatSize } from "@/components/analytics/format-size";
import { LIBRARY_LOOK, LookGlyph } from "@/components/look";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";

export type AudioUsage = { bytes: number; calls: number; capBytes: number };

const MB = 1024 * 1024;
const MAX_CAP_MB = 8_000;
/** Au-delà, un appel de plus ne passera sans doute plus : on le dit avant. */
const NEARLY_FULL = 95;

/**
 * La jauge de l'audio conservé, son plafond, et « tout retirer ».
 *
 * Réservée à qui configure l'application (voir
 * /api/admin/recordings/audio/storage) : elle compte TOUTE la base, y compris
 * l'audio d'appels qu'un regard restreint ne voit pas. C'est aussi le seul
 * endroit où l'on voit qu'on approche du plafond — au-delà, les appels marqués
 * cessent d'être conservés, sans autre bruit.
 */
export function AudioStoragePanel({ usage }: { usage: AudioUsage }) {
  const t = useTranslations("analytics");
  const locale = useLocale();
  const router = useRouter();
  const [capMb, setCapMb] = useState(String(Math.round(usage.capBytes / MB)));
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const pct = usage.capBytes > 0 ? Math.min(100, (usage.bytes / usage.capBytes) * 100) : 100;
  const parsedCap = Number(capMb);
  const capValid = capMb.trim() !== "" && Number.isInteger(parsedCap) && parsedCap >= 0 && parsedCap <= MAX_CAP_MB;

  const saveCap = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/recordings/audio/storage", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capMb: parsedCap }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success(t("library.storageCapSaved"));
      router.refresh();
    } catch {
      toast.error(t("library.genericError"));
    } finally {
      setSaving(false);
    }
  };

  const removeAll = async () => {
    setRemoving(true);
    try {
      const res = await fetch("/api/admin/recordings/audio/storage", { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { calls?: number } | null;
      if (!res.ok) throw new Error(String(res.status));
      toast.success(t("library.storageRemovedAll", { count: data?.calls ?? 0 }));
      setConfirming(false);
      router.refresh();
    } catch {
      toast.error(t("library.genericError"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section
      aria-labelledby="audio-storage-title"
      className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10"
    >
      <h2
        id="audio-storage-title"
        className="flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
      >
        <LookGlyph look={LIBRARY_LOOK.kept} className="size-3.5" />
        {t("library.storageTitle")}
      </h2>
      <p className="text-sm font-medium tabular-nums">
        {t("library.storageUsed", {
          used: formatSize(usage.bytes, locale),
          cap: formatSize(usage.capBytes, locale),
        })}
      </p>
      <Progress value={pct} aria-label={t("library.storageTitle")} />
      <p className="text-xs text-muted-foreground">
        {t("library.storageCalls", { count: usage.calls })}
      </p>
      {usage.capBytes === 0 ? (
        <p className="text-xs font-medium">{t("library.storageOff")}</p>
      ) : pct >= NEARLY_FULL ? (
        <p className="text-xs font-medium">{t("library.storageFull")}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("library.storageHint")}</p>

      <div className="space-y-1.5 pt-1">
        <Label htmlFor="audio-cap">{t("library.storageCap")}</Label>
        <div className="flex gap-2">
          <Input
            id="audio-cap"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_CAP_MB}
            step={1}
            value={capMb}
            onChange={(e) => setCapMb(e.target.value)}
            className="h-11 min-w-0 md:h-9"
          />
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0 md:h-9"
            disabled={saving || !capValid}
            onClick={() => void saveCap()}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("library.storageCapSave")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("library.storageCapHint")}</p>
      </div>

      {usage.calls > 0 ? (
        <Button
          type="button"
          variant="ghost"
          className="h-11 w-full text-destructive md:h-9"
          onClick={() => setConfirming(true)}
        >
          {t("library.storageRemoveAll")}
        </Button>
      ) : null}

      {confirming ? (
        <AlertDialog open onOpenChange={(o) => (!o ? setConfirming(false) : undefined)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("library.storageRemoveAllTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("library.storageRemoveAllBody", { size: formatSize(usage.bytes, locale) })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("library.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={removing}
                onClick={() => void removeAll()}
              >
                {removing ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("library.storageRemoveAll")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}
