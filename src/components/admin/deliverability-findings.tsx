import { ExternalLinkIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactElement } from "react";
import {
  DELIVERABILITY_LOOK,
  LookGlyph,
  VERDICT_LOOK,
  lookTint,
  type Look,
} from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { Finding, FindingSeverity, MetricUnit } from "@/lib/deliverability/types";
import { cn } from "@/lib/utils";

/**
 * « À corriger » — la SEULE partie de l'écran de délivrabilité qui demande un
 * geste. Tout le reste est un chiffre ; ceci est une liste de tâches.
 *
 * Trois décisions de mise en forme portent tout le bloc :
 *
 *  · **La correction est la ligne la plus forte.** `why` explique pourquoi un
 *    opérateur s'en soucie — c'est ce qui empêche de balayer la liste sans
 *    rien faire — mais `fix` est la seule phrase qui change quelque chose. En
 *    gris de la même taille que le reste, elle se lit comme un commentaire et
 *    la liste redevient un journal.
 *  · **La gravité s'écrit, elle ne se peint pas.** Le pictogramme et le liseré
 *    doublent un libellé (« À corriger » / « À surveiller ») ; un constat
 *    d'information n'en porte aucun, parce que le gris neutre n'affirme rien
 *    et qu'aucun texte du registre ne dirait honnêtement « pour information ».
 *    L'ordre — danger, puis avertissement, puis information — fait le reste.
 *  · **La famille n'est pas la gravité.** Une apostrophe courbe et un compte
 *    suspendu portent deux pastilles indépendantes ; les fondre ferait
 *    clignoter la page en rouge pour un détail de texte, et l'opérateur
 *    cesserait de l'ouvrir — exactement ce qu'un écran de surveillance ne peut
 *    pas se permettre.
 *
 * Composant SERVEUR et SYNCHRONE : `useTranslations` de next-intl fonctionne
 * en RSC comme sous `NextIntlClientProvider`, alors qu'un composant `async`
 * ne se rend pas dans un test `renderToStaticMarkup` — la façon dont ce dépôt
 * vérifie ses écrans.
 */

/** Une gravité de constat → le verdict qui lui prête son pictogramme. */
const SEVERITY_LOOKS: Record<FindingSeverity, Look> = {
  danger: VERDICT_LOOK.danger,
  warn: VERDICT_LOOK.warn,
  // « Pour information » n'est pas « tout va bien » : le point d'interrogation
  // gris du verdict inconnu dit qu'il y a là quelque chose à lire, pas à faire.
  info: VERDICT_LOOK.unknown,
};

/** Le pire d'abord. Un danger sous trois avertissements ne se lit jamais. */
const SEVERITY_ORDER = ["danger", "warn", "info"] as const;

/** Au-delà de cinq pièces, on ne montre plus des cas : on montre du bruit. */
const MAX_SAMPLES = 5;

type Formats = {
  /** Entiers nus — un compte de messages n'a pas de décimale. */
  int: Intl.NumberFormat;
  /** Une décimale au plus : « 4,2 sortants pour un entrant » se lit, « 4,17 » non. */
  decimal: Intl.NumberFormat;
  percent: Intl.NumberFormat;
  /** « 8 856 min » — l'unité est posée par `Intl`, jamais écrite en dur. */
  minutes: Intl.NumberFormat;
};

function formats(locale: string): Formats {
  const tag = locale === "en" ? "en-CA" : "fr-CA";
  return {
    int: new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }),
    decimal: new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }),
    percent: new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 }),
    minutes: new Intl.NumberFormat(tag, {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }),
  };
}

/**
 * L'unité décide de la mise en forme, jamais le calcul : `assess` rend des
 * nombres nus (les taux entre 0 et 1), et c'est ici qu'ils deviennent « 4,3 % »
 * ou « 1 240 ». Un taux préformaté côté serveur serait intraduisible.
 */
function formatUnit(value: number, unit: MetricUnit, nf: Formats): string {
  switch (unit) {
    case "rate":
      return nf.percent.format(value);
    case "ratio":
    case "segments":
      return nf.decimal.format(value);
    // « 8 856 » tout court se lit comme un nombre de messages ; à côté d'un
    // « seuil 60 » sans unité, personne ne devine qu'il s'agit de minutes.
    case "minutes":
      return nf.minutes.format(value);
    case "count":
      return nf.int.format(value);
  }
}

export function DeliverabilityFindings({
  findings,
  moreCount,
}: {
  findings: Finding[];
  moreCount: number;
}): ReactElement {
  const t = useTranslations("admin");
  const nf = formats(useLocale());

  // Le serveur trie déjà par gravité ; on regroupe quand même, parce qu'un
  // écran qui dépend de l'ordre d'un appelant finit par afficher un danger en
  // troisième position le jour où quelqu'un ajoute un tri.
  const groups = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: findings.filter((f) => f.severity === severity),
  })).filter((group) => group.items.length > 0);

  // Un barreau de campagne écrit à la main ne passe par AUCUN garde-fou : la
  // phrase la plus utile de l'écran, posée à côté des constats qu'elle
  // explique plutôt que sur un onglet que personne n'ouvre.
  const hasContent = findings.some((f) => f.family === "content");

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle>{t("deliverability.findings.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {findings.length === 0 ? (
          // Rien à corriger n'est pas une panne : pastille calme, pas d'alerte.
          <EmptyState
            icon={<LookGlyph look={VERDICT_LOOK.ok} />}
            title={t("deliverability.findings.none")}
            hint={t("deliverability.findings.noneHint")}
          />
        ) : (
          <>
            {hasContent ? (
              <div
                className="flex items-start gap-2 rounded-lg border p-3"
                style={{
                  borderColor: lookTint(DELIVERABILITY_LOOK.content).borderColor,
                  backgroundColor: lookTint(DELIVERABILITY_LOOK.content).backgroundColor,
                }}
              >
                <LookGlyph look={DELIVERABILITY_LOOK.content} className="mt-0.5" />
                <p className="text-sm">
                  <span className="font-medium">{t("deliverability.family.content")}</span>{" "}
                  <span className="text-muted-foreground">{t("deliverability.content.hint")}</span>
                </p>
              </div>
            ) : null}

            {groups.map((group) => (
              <ul key={group.severity} className="space-y-3">
                {group.items.map((finding, index) => (
                  <FindingBlock
                    // Deux campagnes fautives donnent deux constats de même
                    // identifiant : le sujet les sépare, l'index tranche le
                    // reste.
                    key={`${finding.id}-${finding.subject ?? index}`}
                    finding={finding}
                    nf={nf}
                    t={t}
                  />
                ))}
              </ul>
            ))}

            {moreCount > 0 ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("deliverability.findings.more", { count: nf.int.format(moreCount) })}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Le traducteur du namespace `admin`, tel que next-intl le rend. */
type Translator = ReturnType<typeof useTranslations<"admin">>;

function FindingBlock({
  finding,
  nf,
  t,
}: {
  finding: Finding;
  nf: Formats;
  t: Translator;
}): ReactElement {
  const severityLook = SEVERITY_LOOKS[finding.severity];
  const familyLook = DELIVERABILITY_LOOK[finding.family];
  const familyTint = lookTint(familyLook);
  const severityTint = lookTint(severityLook);
  const evidence = finding.evidence;
  const samples = evidence.samples.slice(0, MAX_SAMPLES);
  /**
   * Combien de cas existent AU-DELÀ de ce qu'on montre.
   *
   * Deux sources : la liste locale coupée à cinq, et le drapeau du calcul
   * quand la mesure elle-même a été plafonnée en amont. « 0 autres cas » ne
   * s'affiche jamais — ce serait du bruit là où l'on voulait une précision.
   */
  const hiddenSamples = Math.max(
    evidence.samples.length - MAX_SAMPLES,
    evidence.truncated && evidence.unit === "count" && evidence.value !== null
      ? Math.round(evidence.value) - samples.length
      : 0,
  );
  // Une valeur absente sur un indicateur MESURÉ veut dire « échantillon trop
  // mince », pas « zéro ». Un constat structurel (interrupteur d'arrêt, cron
  // absent) n'a pas d'indicateur du tout : il n'affiche pas de chiffre plutôt
  // que d'afficher un tiret qui ferait croire à une mesure ratée.
  const measured = evidence.metric !== null;
  const showNumbers = measured || evidence.value !== null;

  return (
    <li
      // Le liseré reprend la teinte de la gravité : empilés sur téléphone, les
      // constats se trient à l'œil avant d'être lus. Il DOUBLE le pictogramme
      // et la pastille, il ne les remplace pas.
      className="rounded-lg border border-l-[3px] p-3"
      style={{ borderLeftColor: severityTint.borderColor }}
    >
      <div className="flex items-start gap-2">
        <LookGlyph look={severityLook} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">{finding.title}</p>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className="gap-1 pl-1.5 font-normal"
              // La teinte prend le fond et la bordure, jamais le libellé : un
              // mot de douze pixels dans la couleur du concept se lit mal.
              style={{
                borderColor: familyTint.borderColor,
                backgroundColor: familyTint.backgroundColor,
              }}
            >
              <LookGlyph look={familyLook} className="size-3" />
              {t(`deliverability.family.${finding.family}`)}
            </Badge>

            {finding.severity === "info" ? null : (
              <Badge
                variant="outline"
                className="gap-1 pl-1.5 font-medium"
                style={{
                  borderColor: severityTint.borderColor,
                  backgroundColor: severityTint.backgroundColor,
                }}
              >
                <LookGlyph look={severityLook} className="size-3" />
                {t(`deliverability.verdict.${finding.severity}`)}
              </Badge>
            )}

            {finding.subject ? (
              <span className="min-w-0 text-xs text-muted-foreground">
                <span className="font-medium">{t("deliverability.findings.subject")}</span>{" "}
                <span className="break-words">{finding.subject}</span>
              </span>
            ) : null}
          </div>

          <p className="text-sm text-muted-foreground">{finding.why}</p>

          {/* La correction : fond plein et graisse pleine. C'est la seule
              phrase du bloc qui change quelque chose. */}
          <p className="rounded-md bg-muted px-3 py-2 text-sm font-semibold">{finding.fix}</p>

          {showNumbers || samples.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("deliverability.findings.evidence")}
              </p>

              {showNumbers ? (
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      evidence.value === null && "text-muted-foreground",
                    )}
                  >
                    {evidence.value === null ? "—" : formatUnit(evidence.value, evidence.unit, nf)}
                  </span>
                  {evidence.threshold === null ? null : (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t("deliverability.findings.threshold", {
                        value: formatUnit(evidence.threshold, evidence.unit, nf),
                      })}
                    </span>
                  )}
                  {evidence.value === null && measured ? (
                    <span className="text-xs text-muted-foreground">
                      {t("deliverability.findings.sampleTooSmall")}
                    </span>
                  ) : null}
                </p>
              ) : null}

              {samples.length > 0 ? (
                <ul className="space-y-1.5">
                  {samples.map((sample, index) => (
                    <li
                      key={`${sample.label}-${index}`}
                      className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-2">
                        {sample.href ? (
                          <Link
                            href={sample.href}
                            // Cible tactile : la pièce se touche au pouce sur
                            // le téléphone d'un téléphoniste, pas à la souris.
                            className="inline-flex min-h-11 min-w-0 items-center break-words underline underline-offset-2 md:min-h-0"
                          >
                            {sample.label}
                          </Link>
                        ) : (
                          <span className="min-w-0 break-words">{sample.label}</span>
                        )}
                        {sample.count === undefined ? null : (
                          <span className="tabular-nums text-muted-foreground">
                            {nf.int.format(sample.count)}
                          </span>
                        )}
                      </div>
                      {sample.excerpt ? (
                        // L'extrait est du texte de client : il retourne à la
                        // ligne au lieu d'élargir la page, sur laquelle rien ne
                        // défile jamais latéralement.
                        <p className="mt-1 font-mono break-words whitespace-pre-wrap text-muted-foreground">
                          {sample.excerpt}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* Une liste tronquée qui se lit comme une liste complète est un
                  mensonge par omission : l'opérateur corrige cinq cas et croit
                  en avoir corrigé quarante. */}
              {hiddenSamples > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("deliverability.findings.moreSamples", { count: hiddenSamples })}
                </p>
              ) : null}
            </div>
          ) : null}

          {finding.deepLink !== null || finding.sourceUrl ? (
            <div className="flex flex-wrap items-center gap-3 pt-0.5">
              {finding.deepLink === null ? null : (
                <Button
                  size="sm"
                  variant={finding.severity === "danger" ? "default" : "outline"}
                  className="min-h-11 md:min-h-7"
                  render={
                    finding.external ? (
                      // Une cible externe s'ouvre à côté : perdre la page de
                      // délivrabilité pour aller lire la console Twilio, c'est
                      // perdre la liste de ce qu'il restait à corriger.
                      <Link href={finding.deepLink} target="_blank" rel="noreferrer" />
                    ) : (
                      <Link href={finding.deepLink} />
                    )
                  }
                >
                  {finding.external ? <ExternalLinkIcon aria-hidden /> : null}
                  {finding.external
                    ? t("deliverability.findings.openExternal")
                    : t("deliverability.findings.fixHere")}
                </Button>
              )}

              {finding.sourceUrl ? (
                <a
                  href={finding.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 md:min-h-0"
                >
                  <ExternalLinkIcon aria-hidden className="size-3" />
                  {t("deliverability.findings.source")}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
