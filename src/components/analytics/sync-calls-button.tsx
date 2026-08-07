"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Synchronisation voip.ms à la demande (admin) : rapatrie CDR + enregistrements
 * d'appels des dernières 48 h sans attendre le cron du matin, puis recharge le
 * journal. La requête peut durer — l'API voip.ms est lente (jusqu'à ~90 s).
 */
export function SyncCallsButton() {
  const t = useTranslations("analytics");
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const sync = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/calls/sync", { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        recordingsAttached?: number;
        cdrRows?: number;
        errors?: string[];
      } | null;
      if (!res.ok || !data) {
        toast.error(t("callsPage.syncFailed"));
        return;
      }
      toast.success(
        t("callsPage.syncDone", {
          cdr: data.cdrRows ?? 0,
          attached: data.recordingsAttached ?? 0,
        }),
      );
      if (data.errors && data.errors.length > 0) {
        toast.warning(data.errors[0]);
      }
      router.refresh();
    } catch {
      toast.error(t("callsPage.syncFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="h-11"
      disabled={busy}
      onClick={() => void sync()}
    >
      <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
      {busy ? t("callsPage.syncRunning") : t("callsPage.syncNow")}
    </Button>
  );
}
