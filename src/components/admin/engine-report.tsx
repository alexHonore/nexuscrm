"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AssistantRow,
  CampaignRow,
  EngineSummary,
} from "@/lib/golive-server/reporting";
import { cn } from "@/lib/utils";

/**
 * Bilan du moteur.
 *
 * Les désabonnements sont AFFICHÉS À CÔTÉ des réponses, jamais sur un autre
 * écran : un bon taux de réponse accompagné de beaucoup d'arrêts n'est pas un
 * succès, et séparer les deux laisse conclure l'inverse. Même raison pour les
 * envois en échec, à côté des envois : un échec ressemble à un succès tant
 * qu'on ne l'affiche pas.
 */
export function EngineReport({
  summary,
  assistants,
  campaigns,
}: {
  summary: EngineSummary;
  assistants: AssistantRow[];
  campaigns: CampaignRow[];
}) {
  const t = useTranslations("assistants");
  const deliveryRate =
    summary.outbound === 0 ? null : Math.round((summary.delivered / summary.outbound) * 100);
  const replyRate =
    summary.conversationsTouched === 0
      ? null
      : Math.round((summary.conversationsWithReply / summary.conversationsTouched) * 100);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("report.title")}</CardTitle>
          <CardDescription>{t("report.since", { days: summary.sinceDays })}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t("report.outbound")} value={summary.outbound} />
          <Stat
            label={t("report.delivered")}
            value={summary.delivered}
            hint={deliveryRate === null ? undefined : `${deliveryRate} %`}
          />
          {/* Ce qui n'est pas parti, à côté de ce qui est parti. */}
          <Stat label={t("report.failed")} value={summary.failed} tone={summary.failed > 0 ? "bad" : undefined} />
          <Stat label={t("report.inbound")} value={summary.inbound} />

          <Stat
            label={t("report.replies")}
            value={summary.conversationsWithReply}
            hint={replyRate === null ? undefined : `${replyRate} %`}
            tone="good"
          />
          {/* La contrepartie, sur la MÊME ligne de lecture. */}
          <Stat
            label={t("report.optOuts")}
            value={summary.optOuts}
            tone={summary.optOuts > 0 ? "bad" : undefined}
          />
          <Stat label={t("report.handoffs")} value={summary.handoffs} />
          <Stat
            label={t("report.blocked")}
            value={summary.blockedDrafts}
            tone={summary.blockedDrafts > 0 ? "warn" : undefined}
          />

          <Stat label={t("report.agentTurns")} value={summary.agentTurns} />
          <Stat label={t("report.cost")} value={`${summary.costUsd.toFixed(2)} $`} />
          <Stat label={t("report.suppressed")} value={summary.suppressedTotal} />
        </CardContent>
      </Card>

      {assistants.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("report.byAssistant")}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("report.columns.name")}</TableHead>
                  <TableHead>{t("report.columns.turns")}</TableHead>
                  <TableHead>{t("report.columns.sent")}</TableHead>
                  <TableHead>{t("report.columns.blocked")}</TableHead>
                  <TableHead>{t("report.columns.handoffs")}</TableHead>
                  <TableHead>{t("report.columns.cost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assistants.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="max-w-40 truncate">
                      {a.name}{" "}
                      <Badge variant={a.status === "active" ? "default" : "secondary"} className="ml-1">
                        {t(`list.status.${a.status}` as never)}
                      </Badge>
                    </TableCell>
                    <TableCell>{a.turns}</TableCell>
                    <TableCell>{a.sent}</TableCell>
                    <TableCell className={a.blocked > 0 ? "text-amber-600 dark:text-amber-400" : undefined}>
                      {a.blocked}
                    </TableCell>
                    <TableCell>{a.handoffs}</TableCell>
                    <TableCell>{a.costUsd.toFixed(2)} $</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {campaigns.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("report.byCampaign")}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("report.columns.name")}</TableHead>
                  <TableHead>{t("report.columns.enrolled")}</TableHead>
                  <TableHead>{t("report.columns.replyRate")}</TableHead>
                  <TableHead>{t("report.columns.stopRate")}</TableHead>
                  <TableHead>{t("report.columns.booked")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="max-w-40 truncate">{c.name}</TableCell>
                    <TableCell>{c.enrolled}</TableCell>
                    <TableCell>{c.replyRate} %</TableCell>
                    {/* Un taux d'arrêt élevé annule un bon taux de réponse :
                        il se lit sur la même ligne, pas ailleurs. */}
                    <TableCell className={c.stopRate >= 3 ? "font-medium text-destructive" : undefined}>
                      {c.stopRate} %
                    </TableCell>
                    <TableCell>{c.booked}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-heading text-2xl font-semibold tabular-nums",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
        {hint ? <span className="ml-1.5 text-sm font-normal text-muted-foreground">{hint}</span> : null}
      </p>
    </div>
  );
}
