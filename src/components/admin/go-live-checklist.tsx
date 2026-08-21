"use client";

import { AlertTriangleIcon, CheckCircle2, InfoIcon, RocketIcon, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PreflightCheck, PreflightReport } from "@/lib/golive/preflight";
import { cn } from "@/lib/utils";

/**
 * Contrôle avant mise en service.
 *
 * L'écran ne dit pas « prêt / pas prêt » : il énumère. Huit endroits peuvent,
 * chacun, faire qu'aucun message ne parte, et découvrir lequel après avoir
 * cliqué « activer » puis attendu une heure est le pire chemin possible.
 *
 * Les blocages sont en haut, séparés des avertissements : un avertissement ne
 * mérite pas la même urgence, et les mêler ferait ignorer les deux.
 */
export function GoLiveChecklist({ report }: { report: PreflightReport }) {
  const t = useTranslations("assistants");
  const router = useRouter();

  const blockers = report.checks.filter((c) => c.level === "blocker" && !c.ok);
  const warnings = report.checks.filter((c) => c.level === "warning" && !c.ok);
  const passed = report.checks.filter((c) => c.ok && c.level !== "info");
  const info = report.checks.filter((c) => c.level === "info");

  return (
    <div className="space-y-5">
      {report.canSendLive ? (
        <Alert>
          <RocketIcon />
          <AlertTitle>{t("goLive.ready.title")}</AlertTitle>
          <AlertDescription>{t("goLive.ready.body")}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>{t("goLive.notReady.title", { count: blockers.length })}</AlertTitle>
          <AlertDescription>{t("goLive.notReady.body")}</AlertDescription>
        </Alert>
      )}

      {blockers.length > 0 ? (
        <CheckGroup title={t("goLive.blockers")} checks={blockers} tone="blocker" />
      ) : null}
      {warnings.length > 0 ? (
        <CheckGroup title={t("goLive.warnings")} checks={warnings} tone="warning" />
      ) : null}
      {passed.length > 0 ? (
        <CheckGroup title={t("goLive.passed")} checks={passed} tone="ok" />
      ) : null}
      {info.length > 0 ? <CheckGroup title={t("goLive.info")} checks={info} tone="info" /> : null}

      <Button variant="outline" className="min-h-11 md:min-h-9" onClick={() => router.refresh()}>
        {t("goLive.recheck")}
      </Button>
    </div>
  );
}

function CheckGroup({
  title,
  checks,
  tone,
}: {
  title: string;
  checks: PreflightCheck[];
  tone: "blocker" | "warning" | "ok" | "info";
}) {
  const t = useTranslations("assistants");
  const tCommon = useTranslations("common");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {title}
          <Badge variant="secondary" className="ml-2">
            {checks.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {checks.map((check) => (
          <div key={check.id} className="flex items-start gap-2.5">
            {tone === "blocker" ? (
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : tone === "warning" ? (
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            ) : tone === "ok" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            ) : (
              <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", tone === "blocker" && "font-medium")}>
                {t(`goLive.check.${check.id}.label` as never)}
                {check.detail ? (
                  <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                    {check.detail}
                  </span>
                ) : check.id === "dispatcher" ? (
                  // Le module de vérification est pur et ne porte pas de
                  // texte : « jamais » se traduit ici.
                  <span className="ml-1.5 text-xs text-muted-foreground">{tCommon("never")}</span>
                ) : null}
              </p>
              {/* La consigne n'apparaît que quand il y a quelque chose à faire :
                  répéter « comment corriger » sous une ligne verte est du bruit. */}
              {!check.ok ? (
                <p className="text-xs text-muted-foreground">
                  {t(`goLive.check.${check.id}.fix` as never)}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
