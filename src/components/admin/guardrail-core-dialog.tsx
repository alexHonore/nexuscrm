"use client";

import { AlertTriangleIcon, Loader2, SaveIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "./api";

/**
 * Édition du noyau L0.
 *
 * Publier crée une NOUVELLE version ; l'ancienne n'est jamais réécrite. Un
 * message envoyé le mois dernier doit rester reconstituable, et les traces
 * référencent un numéro de version.
 *
 * Conséquence annoncée d'avance, pas découverte après coup : publier rend
 * périmé le prompt de CHAQUE assistant, qui devra être recompilé et re-testé.
 */
export function GuardrailCoreDialog({
  version,
  body,
  open,
  onOpenChange,
}: {
  version: number;
  body: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [draft, setDraft] = useState(body);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signature = `${version}:${open}`;
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setDraft(body);
    setNotes("");
    setError(null);
  }

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ version: number; staleAssistants: number }>(
        "/api/admin/guardrails/core",
        { method: "POST", body: JSON.stringify({ body: draft, notes: notes || null }) },
      );
      toast.success(
        t("guardrails.core.published", {
          version: result.version,
          count: result.staleAssistants,
        }),
      );
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "unchanged" ? t("guardrails.core.unchanged") : t("guardrails.genericError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("guardrails.core.editTitle", { version })}</DialogTitle>
          <DialogDescription>{t("guardrails.core.editHint")}</DialogDescription>
        </DialogHeader>

        <Alert>
          <AlertTriangleIcon />
          <AlertDescription>{t("guardrails.core.publishWarning")}</AlertDescription>
        </Alert>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="core-body">{t("guardrails.core.body")}</Label>
            <Textarea
              id="core-body"
              rows={20}
              className="font-mono text-xs"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="core-notes">{t("guardrails.core.notes")}</Label>
            <Input
              id="core-notes"
              className="min-h-11 md:min-h-9"
              placeholder={t("guardrails.core.notesPlaceholder")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void publish()} disabled={busy || draft.trim().length < 50}>
            {busy ? <Loader2 className="animate-spin" /> : <SaveIcon />}
            {t("guardrails.core.publish", { version: version + 1 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
