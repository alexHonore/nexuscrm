"use client";

import { AlertTriangle, PhoneForwarded } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "./api";

/**
 * L'interrupteur de la sonnerie sur cellulaire.
 *
 * Il ouvre une PORTE, il ne remplit rien : le numéro et l'accord viennent de la
 * personne, depuis /profile. C'est pourquoi cette carte affiche un ÉTAT par
 * téléphoniste (« prêt », « en attente du numéro », « en attente de l'accord »)
 * plutôt qu'un champ à remplir — l'administrateur doit voir qui reste à
 * convaincre, sans jamais pouvoir décider à sa place.
 */

export type ReachRow = {
  userId: string;
  name: string;
  /** La personne a-t-elle enregistré un numéro ? (jamais le numéro lui-même) */
  hasNumber: boolean;
  /** …et a-t-elle accepté qu'il sonne ? */
  consented: boolean;
  /** L'administrateur a-t-il ouvert SA ligne ? */
  lineEnabled: boolean;
};

export function SimulRingCard({
  initialEnabled,
  people,
}: {
  initialEnabled: boolean;
  people: ReachRow[];
}) {
  const t = useTranslations("admin");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [rows, setRows] = useState(people);
  const [pending, setPending] = useState(false);

  const save = async (body: Record<string, unknown>, revert: () => void) => {
    setPending(true);
    try {
      await api("/api/admin/settings/simulring", { method: "POST", body: JSON.stringify(body) });
      toast.success(t("settings.simulRing.saved"));
    } catch {
      revert();
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  const toggleFeature = (next: boolean) => {
    const prev = enabled;
    setEnabled(next);
    void save({ enabled: next }, () => setEnabled(prev));
  };

  const toggleLine = (userId: string, next: boolean) => {
    const prev = rows;
    setRows((list) =>
      list.map((row) => (row.userId === userId ? { ...row, lineEnabled: next } : row)),
    );
    void save({ line: { userId, enabled: next } }, () => setRows(prev));
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <PhoneForwarded aria-hidden className="size-4 text-muted-foreground" />
          {t("settings.simulRing.title")}
        </CardTitle>
        <CardDescription>{t("settings.simulRing.desc")}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <p className="text-sm text-muted-foreground">{t("settings.simulRing.why")}</p>

        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <Label htmlFor="simulring-enabled" className="text-sm font-medium">
            {t("settings.simulRing.enable")}
            <span className="block text-xs font-normal text-muted-foreground">
              {enabled ? t("settings.simulRing.on") : t("settings.simulRing.off")}
            </span>
          </Label>
          <Switch
            id="simulring-enabled"
            checked={enabled}
            onCheckedChange={toggleFeature}
            disabled={pending}
          />
        </div>

        {/*
          L'avertissement reste visible même éteint : c'est ce qu'il faut avoir
          lu AVANT d'allumer, pas après avoir perdu un appelant dans une boîte
          vocale personnelle.
        */}
        <Alert>
          <AlertTriangle aria-hidden className="size-4" />
          <AlertDescription>{t("settings.simulRing.voicemailWarning")}</AlertDescription>
        </Alert>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("settings.simulRing.peopleTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("settings.simulRing.consentNote")}</p>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.simulRing.noOne")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {rows.map((row) => {
                // L'ordre des trois états est celui du chemin à parcourir : on
                // nomme le PREMIER obstacle, pas tous à la fois.
                const status = !row.hasNumber
                  ? t("settings.simulRing.waitingNumber")
                  : !row.consented
                    ? t("settings.simulRing.waitingConsent")
                    : t("settings.simulRing.ready");
                return (
                  <li
                    key={row.userId}
                    className="flex min-h-14 items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{row.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{status}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {row.lineEnabled
                          ? t("settings.simulRing.lineOn")
                          : t("settings.simulRing.lineOff")}
                      </span>
                      <Switch
                        checked={row.lineEnabled}
                        onCheckedChange={(next) => toggleLine(row.userId, next)}
                        disabled={pending || !enabled}
                        aria-label={row.name}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{t("settings.simulRing.provisionNote")}</p>
      </CardContent>
    </Card>
  );
}
