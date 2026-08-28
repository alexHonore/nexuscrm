import { useLocale, useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { DELIVERABILITY_LOOK, LookGlyph, VERDICT_LOOK } from "@/components/look";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DeliverabilityReport, TemplateCluster } from "@/lib/deliverability/types";
import { cn } from "@/lib/utils";

/**
 * « Gabarits envoyés » — le même texte, regroupé, et surtout : depuis combien
 * de numéros il part.
 *
 * Répéter un texte depuis UN numéro est le métier normal d'une campagne. Le
 * répéter depuis plusieurs est de l'essaimage — le motif que la CTIA nomme et
 * que les opérateurs cherchent — et c'est la seule colonne de ce tableau qui
 * alarme. Les envois et les destinataires sont là pour situer, pas pour juger :
 * une campagne conforme envoie le même texte à tout le monde.
 *
 * Le tri vient du serveur. Cet écran ne réordonne rien : deux tris qui se
 * contredisent, c'est un jour à comprendre pourquoi la ligne du haut n'est pas
 * celle qu'on attendait.
 *
 * Composant SERVEUR et SYNCHRONE — voir la note de `deliverability-findings`.
 */

/**
 * Vingt groupes affichés, jamais plus. On agit sur les premiers ; la queue
 * d'un balayage de gabarits est faite de messages uniques, qui ne se corrigent
 * pas et n'apprennent rien.
 */
const MAX_CLUSTERS = 20;

export function DeliverabilityTemplates({
  templates,
}: {
  templates: DeliverabilityReport["templates"];
}): ReactElement {
  const t = useTranslations("admin");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA", {
    maximumFractionDigits: 0,
  });

  const clusters = templates.clusters.slice(0, MAX_CLUSTERS);

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle>{t("deliverability.templates.title")}</CardTitle>
        <CardDescription>{t("deliverability.templates.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {clusters.length === 0 ? (
          <EmptyState
            icon={<LookGlyph look={DELIVERABILITY_LOOK.shape} />}
            title={t("deliverability.templates.empty")}
          />
        ) : (
          <>
            {/* Desktop — le conteneur de `Table` défile tout seul ; la page,
                elle, ne part jamais de côté. */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-full">
                      {t("deliverability.templates.cluster")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("deliverability.templates.sends")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("deliverability.templates.recipients")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("deliverability.templates.senders")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clusters.map((cluster, index) => {
                    const spread = isSpread(cluster);
                    return (
                      <TableRow key={`${index}-${cluster.representativeBody.slice(0, 32)}`}>
                        <TableCell className="max-w-0 align-top whitespace-normal">
                          {/* Le corps RÉEL le plus fréquent du groupe, coupé à
                              trois lignes : on reconnaît le message, on ne le
                              relit pas. */}
                          <p className="line-clamp-3 break-words whitespace-pre-wrap">
                            {cluster.representativeBody}
                          </p>
                          {spread ? <SpreadWarning cluster={cluster} nf={nf} t={t} /> : null}
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums">
                          {nf.format(cluster.messages)}
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums">
                          {nf.format(cluster.distinctRecipients)}
                        </TableCell>
                        <TableCell className="align-top">
                          <span
                            className={cn(
                              "flex items-center justify-end gap-1 tabular-nums",
                              spread && "font-semibold text-destructive",
                            )}
                          >
                            {spread ? <LookGlyph look={VERDICT_LOOK.danger} className="size-3.5" /> : null}
                            {nf.format(cluster.distinctSendingNumbers)}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile — un tableau à quatre colonnes ne se lit pas au pouce. */}
            <div className="space-y-2 md:hidden">
              {clusters.map((cluster, index) => {
                const spread = isSpread(cluster);
                return (
                  <div
                    key={`${index}-${cluster.representativeBody.slice(0, 32)}`}
                    className="space-y-1.5 rounded-lg border p-3"
                  >
                    <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap">
                      {cluster.representativeBody}
                    </p>
                    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <dt>{t("deliverability.templates.sends")}</dt>
                        <dd className="font-medium text-foreground tabular-nums">
                          {nf.format(cluster.messages)}
                        </dd>
                      </div>
                      <div className="flex items-center gap-1">
                        <dt>{t("deliverability.templates.recipients")}</dt>
                        <dd className="font-medium text-foreground tabular-nums">
                          {nf.format(cluster.distinctRecipients)}
                        </dd>
                      </div>
                      <div className="flex items-center gap-1">
                        <dt>{t("deliverability.templates.senders")}</dt>
                        <dd
                          className={cn(
                            "flex items-center gap-1 font-medium tabular-nums",
                            spread ? "text-destructive" : "text-foreground",
                          )}
                        >
                          {spread ? (
                            <LookGlyph look={VERDICT_LOOK.danger} className="size-3.5" />
                          ) : null}
                          {nf.format(cluster.distinctSendingNumbers)}
                        </dd>
                      </div>
                    </dl>
                    {spread ? <SpreadWarning cluster={cluster} nf={nf} t={t} /> : null}
                  </div>
                );
              })}
            </div>

            {templates.truncated ? (
              // Un balayage tronqué qui se lit comme un balayage complet fait
              // conclure « aucun essaimage » sur une moitié de période.
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("deliverability.templates.truncated", { count: nf.format(templates.scanned) })}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Deux numéros pour un même texte : le signal d'essaimage, et lui seul. */
function isSpread(cluster: TemplateCluster): boolean {
  return cluster.distinctSendingNumbers > 1;
}

/** Le traducteur du namespace `admin`, tel que next-intl le rend. */
type Translator = ReturnType<typeof useTranslations<"admin">>;

/**
 * La phrase qui porte l'alarme. Le rouge et le pictogramme la doublent : seule,
 * une couleur ne dit à personne ce qu'il faut regarder — et surtout pas à qui
 * lit l'écran en plein soleil sur un téléphone.
 */
function SpreadWarning({
  cluster,
  nf,
  t,
}: {
  cluster: TemplateCluster;
  nf: Intl.NumberFormat;
  t: Translator;
}): ReactElement {
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-destructive">
      <LookGlyph look={VERDICT_LOOK.danger} className="mt-px size-3.5" />
      <span className="break-words">
        {t("deliverability.templates.spreadWarning", {
          count: nf.format(cluster.distinctSendingNumbers),
        })}
      </span>
    </p>
  );
}
