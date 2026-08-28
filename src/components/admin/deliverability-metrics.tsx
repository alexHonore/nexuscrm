import { getLocale, getTranslations } from "next-intl/server";
import type { ReactElement } from "react";
import { DELIVERABILITY_LOOK, LookGlyph, VERDICT_LOOK, lookTint } from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  DeliverabilityReport,
  Metric,
  MetricId,
  NumberReport,
  MetricUnit,
  SkipCount,
  Verdict,
} from "@/lib/deliverability/types";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

/**
 * Les CHIFFRES de la délivrabilité : la grille d'indicateurs, le bulletin par
 * numéro expéditeur, et ce qui n'est jamais parti.
 *
 * Trois composants serveur. Tout est déjà mesuré quand la page se rend : ces
 * composants ne calculent rien, ne devinent rien, et n'ont donc ni état ni
 * aller-retour. Ce qu'ils font — et c'est tout ce qu'ils font — c'est METTRE
 * EN FORME : une valeur, son verdict, son seuil, et d'où vient ce seuil.
 *
 * Deux règles tiennent l'écran entier :
 *
 *  · **« Inconnu » n'est pas « bon ».** Un taux calculé sur onze messages ne
 *    s'affiche pas : il rend un tiret. Le peindre en vert ferait croire qu'on
 *    surveille une chose qu'on ne surveille pas, et c'est précisément la
 *    panne du 25 août — des envois qui partaient, des accusés qui n'arrivaient
 *    plus, et un tableau de bord qui n'avait l'air de rien.
 *  · **La couleur ne dit jamais rien toute seule.** Chaque verdict arrive avec
 *    son pictogramme (`VERDICT_LOOK`) ET son libellé. Un rouge sans mot est
 *    illisible pour un œil deutéranope, et un ambre de onze pixels ne se
 *    remarque pas du tout sur un cellulaire en plein soleil.
 */

/** Ce qu'on écrit quand on ne SAIT pas. Jamais « 0 » : zéro est une mesure. */
const UNKNOWN = "—";

/**
 * Le signe « fois » d'un rapport (« 5,3 × »). Un symbole mathématique, pas une
 * chaîne d'interface : il s'écrit pareil en français et en anglais, comme le
 * « % » que `Intl` pose lui-même. Le mettre au catalogue de traduction
 * inviterait à le traduire, et « 5,3 times » n'existe dans aucune langue.
 */
const TIMES = "×";

/**
 * Les HUIT indicateurs qui décident si le trafic est sain — ceux qu'on lit
 * avant tout le reste : est-ce arrivé (remise, filtrage, erreurs, accusés),
 * qui a dit stop (désabonnements), est-ce lu (réponses), qu'est-ce que ça
 * coûte (UCS-2), la machine tourne-t-elle (répartiteur).
 *
 * Les vingt et un autres restent affichés en dessous, en plus dense : les
 * masquer derrière un bouton reviendrait à ne jamais les regarder, et c'est
 * souvent l'un d'eux qui explique les huit premiers.
 */
const HEADLINE_METRICS: readonly MetricId[] = [
  "delivered_rate",
  "filtered_rate",
  "optout_rate",
  "reply_rate",
  "total_error_rate",
  "no_dlr_rate",
  "ucs2_rate",
  "dispatcher_age",
];

/**
 * La teinte du CHIFFRE. « Bon » garde la couleur du texte : peindre en vert
 * vingt-neuf valeurs correctes noierait les deux qui ne le sont pas.
 * « Inconnu » part en gris — c'est un tiret, pas un résultat.
 */
const VALUE_TONE: Record<Verdict, string> = {
  ok: "",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
  unknown: "text-muted-foreground",
};

/** La teinte du LIBELLÉ de verdict, sous le chiffre. */
const VERDICT_TONE: Record<Verdict, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
  unknown: "text-muted-foreground",
};

/**
 * Les colonnes chiffrées du bulletin par numéro, dans l'ordre de lecture :
 * est-ce arrivé, est-ce filtré, l'accusé est-il revenu, qu'est-ce que ça
 * coûte, reste-t-il de la marge aujourd'hui.
 */
const NUMBER_COLUMNS: readonly { metric: MetricId; header: string }[] = [
  { metric: "delivered_rate", header: "delivered" },
  { metric: "filtered_rate", header: "filtered" },
  { metric: "no_dlr_rate", header: "noDlr" },
  { metric: "ucs2_rate", header: "ucs2" },
  { metric: "daily_cap_headroom", header: "cap" },
];

/**
 * Les codes d'erreur d'un numéro, du plus lourd au plus léger.
 *
 * Plusieurs corrections disent « traitez d'abord le code le plus fréquent ».
 * Tant que ce tableau n'affichait aucun code, la phrase envoyait l'opérateur
 * chercher une information qui n'existait nulle part dans le produit.
 */
function TopErrors({
  errors,
  label,
  formatCount,
}: {
  errors: NumberReport["topErrors"];
  label: string;
  formatCount: (n: number) => string;
}): ReactElement | null {
  if (errors.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      <span className="sr-only">{label} : </span>
      {errors.map((e, i) => (
        <span key={e.errorCode}>
          {i > 0 ? " · " : null}
          <a
            href={e.doc}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
            title={e.name}
          >
            {e.errorCode}
          </a>
          <span className="tabular-nums"> ({formatCount(e.messages)})</span>
        </span>
      ))}
    </p>
  );
}

/** Une valeur mise en forme selon son unité. */
type FormatValue = (value: number | null, unit: MetricUnit) => string;

/**
 * Les quatre mises en forme, construites une fois par rendu.
 *
 * `Intl` porte le séparateur décimal, l'espace insécable avant le « % » et
 * l'abréviation des minutes : les écrire à la main donnerait « 4.1% » à un
 * lecteur québécois, ce qui se lit comme un chiffre étranger — donc comme un
 * chiffre venu d'ailleurs, donc suspect.
 */
function createFormat(locale: string): FormatValue {
  const tag = locale === "en" ? "en-CA" : "fr-CA";
  const integer = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  // Au plus UNE décimale : « 4,17 % » suggère une précision que 300 messages
  // n'ont pas.
  const percent = new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 });
  const ratio = new Intl.NumberFormat(tag, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const minutes = new Intl.NumberFormat(tag, {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
    maximumFractionDigits: 0,
  });

  return (value, unit) => {
    // `null` (rien à diviser) et NaN sont la MÊME chose à l'écran : on ne sait
    // pas. Les rendre en « 0 » transformerait une absence de mesure en bonne
    // nouvelle.
    if (value === null || !Number.isFinite(value)) return UNKNOWN;
    switch (unit) {
      case "rate":
        return percent.format(value);
      case "minutes":
        return minutes.format(value);
      case "ratio":
        return `${ratio.format(value)} ${TIMES}`;
      case "count":
      case "segments":
        return integer.format(value);
    }
  };
}

// ── Les indicateurs ─────────────────────────────────────────────────────────

/**
 * La grille d'indicateurs : huit tuiles pleines, puis le reste en dense.
 *
 * Même dessin de tuile que l'écran Analytique (libellé gris, grand chiffre en
 * `tabular-nums`, aide en dessous) : ce sont deux tableaux de bord du même
 * produit, et un opérateur qui passe de l'un à l'autre ne doit pas avoir à
 * réapprendre où regarder.
 */
export async function DeliverabilityMetrics({
  report,
}: {
  report: DeliverabilityReport;
}): Promise<ReactElement> {
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const format = createFormat(locale);
  const provenanceHint = t("deliverability.provenance.hint");

  const headline = HEADLINE_METRICS.map((id) => report.metrics.find((m) => m.id === id)).filter(
    (m): m is Metric => m !== undefined,
  );
  const rest = report.metrics.filter((m) => !HEADLINE_METRICS.includes(m.id));

  /**
   * Ce qui se dit à côté du pictogramme de verdict. Pour « inconnu », le mot
   * exact du problème (« trop peu de messages pour trancher ») plutôt que le
   * verdict lui-même : c'est la seule ligne qui empêche de lire un tiret comme
   * une panne.
   */
  const verdictText = (verdict: Verdict): string =>
    verdict === "unknown"
      ? t("deliverability.findings.sampleTooSmall")
      : t(`deliverability.verdict.${verdict}`);

  /** « seuil 2 % » — dans l'unité de l'indicateur, jamais en nombre nu. */
  const thresholdText = (metric: Metric): string | null =>
    metric.verdict !== "ok" && metric.verdict !== "unknown" && metric.threshold !== null
      ? t("deliverability.findings.threshold", { value: format(metric.threshold, metric.unit) })
      : null;

  const tile = (metric: Metric, compact: boolean) => {
    const look = VERDICT_LOOK[metric.verdict];
    const threshold = thresholdText(metric);
    // Un verdict « inconnu » n'affiche PAS sa valeur, même quand il y en a
    // une : deux échecs sur trois messages ne sont pas 67 % d'échec, et ce
    // chiffre-là se retiendrait mieux que l'avertissement qui l'accompagne.
    const value = metric.verdict === "unknown" ? UNKNOWN : format(metric.value, metric.unit);

    return (
      <Card key={metric.id} size="sm" className="shadow-xs">
        <CardContent className="space-y-0.5">
          <p className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
            {t(`deliverability.metric.${metric.id}.label`)}
          </p>
          <p
            className={cn(
              "font-semibold tabular-nums",
              compact ? "text-lg" : "text-2xl",
              VALUE_TONE[metric.verdict],
            )}
          >
            {value}
          </p>
          {/* Le pictogramme DOUBLE le mot du verdict, il ne le remplace pas :
              seul, il serait une devinette, et la teinte seule ne survit pas à
              un daltonisme ni à un écran de cellulaire en plein jour. */}
          <p
            className={cn(
              "flex items-start gap-1.5 text-[11px]",
              VERDICT_TONE[metric.verdict],
            )}
          >
            <LookGlyph look={look} className="mt-px size-3.5" />
            <span>
              {verdictText(metric.verdict)}
              {threshold ? ` (${threshold})` : null}
            </span>
          </p>
          <p className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
            {t(`deliverability.metric.${metric.id}.hint`)}
          </p>
          {/* La provenance n'est pas de la décoration : presque aucun opérateur
              ne publie ses barres, et un repère de fournisseur affiché comme
              une règle fabrique une certitude que plus personne ne saura
              défaire le jour où le chiffre est contesté. */}
          <p className="text-[11px] text-muted-foreground/80" title={provenanceHint}>
            {t(`deliverability.provenance.${metric.provenance}`)}
          </p>
        </CardContent>
      </Card>
    );
  };

  return (
    <section aria-label={t("deliverability.tabs.overview")} className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {headline.map((metric) => tile(metric, false))}
      </div>
      {rest.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          {rest.map((metric) => tile(metric, true))}
        </div>
      ) : null}
    </section>
  );
}

// ── Le bulletin par numéro ──────────────────────────────────────────────────

/**
 * Ce que vaut CHAQUE numéro expéditeur.
 *
 * L'opérateur téléphonique note le NUMÉRO, jamais le compte. Une moyenne de
 * compte cache les deux choses qui comptent d'un coup : le numéro sain qu'on
 * pourrait continuer d'utiliser, et le numéro grillé qu'il faut arrêter tout
 * de suite. C'est pour ça que ce tableau existe à côté des indicateurs
 * globaux, et pas à leur place.
 */
export async function DeliverabilityNumbers({
  report,
}: {
  report: DeliverabilityReport;
}): Promise<ReactElement> {
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const format = createFormat(locale);
  const tooSmall = t("deliverability.findings.sampleTooSmall");

  const verdictText = (verdict: Verdict): string =>
    verdict === "unknown" ? tooSmall : t(`deliverability.verdict.${verdict}`);

  /**
   * La pastille de verdict d'une ligne : teinte au fond et à la bordure, mot
   * en couleur de texte normale. Un « À corriger » écrit en rouge de douze
   * pixels se repère MOINS bien qu'un mot noir sur un fond rouge pâle.
   */
  const verdictBadge = (verdict: Verdict) => {
    const tint = lookTint(VERDICT_LOOK[verdict]);
    // Le MOT du verdict dans la pastille, la phrase dans la bulle : « Trop peu
    // de messages pour trancher. » sur chaque ligne d'un tableau de douze
    // numéros fait douze fois la même phrase et plus aucune colonne lisible.
    return (
      <Badge
        variant="outline"
        className="gap-1 pl-1.5 font-medium"
        style={{ borderColor: tint.borderColor, backgroundColor: tint.backgroundColor }}
        title={verdict === "unknown" ? tooSmall : undefined}
      >
        <LookGlyph look={VERDICT_LOOK[verdict]} />
        {t(`deliverability.verdict.${verdict}`)}
      </Badge>
    );
  };

  /**
   * Une cellule chiffrée. Le pictogramme n'apparaît QUE lorsqu'il y a quelque
   * chose à voir : un bouclier vert devant chacune des quarante cellules d'un
   * tableau sain apprend à ne plus regarder le tableau. Le mot du verdict
   * accompagne toujours le pictogramme, pour un lecteur d'écran comme pour la
   * bulle d'aide — la couleur ne porte pas le sens toute seule.
   */
  const metricCell = (metric: Metric | undefined) => {
    if (!metric) return <span className="text-muted-foreground">{UNKNOWN}</span>;
    const value = metric.verdict === "unknown" ? UNKNOWN : format(metric.value, metric.unit);
    const label = verdictText(metric.verdict);
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 tabular-nums",
          VALUE_TONE[metric.verdict],
        )}
        title={metric.verdict === "ok" ? undefined : label}
      >
        {metric.verdict === "ok" ? null : (
          <LookGlyph look={VERDICT_LOOK[metric.verdict]} className="size-3.5" />
        )}
        {value}
        {metric.verdict === "ok" ? null : <span className="sr-only">{label}</span>}
      </span>
    );
  };

  const rows = report.numbers;

  return (
    <section className="space-y-2">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 font-heading text-base font-medium">
          <LookGlyph look={DELIVERABILITY_LOOK.delivery} />
          {t("deliverability.numbers.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("deliverability.numbers.hint")}</p>
      </div>

      {rows.length === 0 ? (
        <Card className="shadow-xs">
          <CardContent>
            <p className="text-sm text-muted-foreground">{t("deliverability.numbers.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Bureau : huit colonnes, qui défilent DANS leur propre cadre
              (`Table` porte son `overflow-x-auto`) — jamais la page entière. */}
          <div className="hidden md:block">
            <Card className="shadow-xs">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("deliverability.numbers.number")}</TableHead>
                      <TableHead className="text-right">
                        {t("deliverability.numbers.sent")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("deliverability.numbers.segments")}
                      </TableHead>
                      {NUMBER_COLUMNS.map((col) => (
                        <TableHead key={col.metric} className="text-right">
                          {t(`deliverability.numbers.${col.header}`)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.smsNumberId}>
                        <TableCell className="align-top">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-sm">{formatPhone(row.e164)}</span>
                              {/* Un numéro désactivé garde son bulletin : c'est
                                  souvent LUI qu'on vient de couper parce qu'il
                                  filtrait, et son historique explique le reste. */}
                              {row.active ? null : (
                                <Badge variant="outline" className="font-normal">
                                  {t("deliverability.numbers.inactive")}
                                </Badge>
                              )}
                            </div>
                            {row.label ? (
                              <p className="truncate text-xs text-muted-foreground">{row.label}</p>
                            ) : null}
                            {verdictBadge(row.verdict)}
                            <TopErrors
                              errors={row.topErrors}
                              label={t("deliverability.numbers.errors")}
                              formatCount={(n) => format(n, "count")}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums">
                          {format(row.messages, "count")}
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums">
                          {format(row.segments, "segments")}
                        </TableCell>
                        {NUMBER_COLUMNS.map((col) => (
                          <TableCell key={col.metric} className="text-right align-top">
                            {metricCell(row.metrics[col.metric])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          {/* Mobile : une carte par numéro. Les téléphonistes et le courtier
              ouvrent cet écran depuis leur cellulaire — un tableau à huit
              colonnes y serait un mur qu'on fait glisser sans jamais le lire. */}
          <div className="space-y-2 md:hidden">
            {rows.map((row) => (
              <Card key={row.smsNumberId} size="sm" className="shadow-xs">
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{formatPhone(row.e164)}</span>
                    {row.active ? null : (
                      <Badge variant="outline" className="font-normal">
                        {t("deliverability.numbers.inactive")}
                      </Badge>
                    )}
                  </div>
                  {row.label ? (
                    <p className="truncate text-xs text-muted-foreground">{row.label}</p>
                  ) : null}
                  {verdictBadge(row.verdict)}
                  <TopErrors
                    errors={row.topErrors}
                    label={t("deliverability.numbers.errors")}
                    formatCount={(n) => format(n, "count")}
                  />
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                    <div>
                      <dt className="text-muted-foreground">
                        {t("deliverability.numbers.sent")}
                      </dt>
                      <dd className="tabular-nums">{format(row.messages, "count")}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("deliverability.numbers.segments")}
                      </dt>
                      <dd className="tabular-nums">{format(row.segments, "segments")}</dd>
                    </div>
                    {NUMBER_COLUMNS.map((col) => (
                      <div key={col.metric}>
                        <dt className="text-muted-foreground">
                          {t(`deliverability.numbers.${col.header}`)}
                        </dt>
                        <dd>{metricCell(row.metrics[col.metric])}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ── Ce qui n'est jamais parti ───────────────────────────────────────────────

/**
 * Les messages arrêtés AVANT l'envoi, par motif.
 *
 * Un dénominateur à part, et il le reste : un arrêt volontaire (numéro
 * désabonné, interrupteur d'arrêt, essai à blanc) n'abîme aucune réputation,
 * et le mélanger aux échecs de remise ferait paniquer sur un moteur qui a
 * justement bien fonctionné. Ce qui se lit ici, c'est l'inverse : un motif qui
 * gonfle sans qu'on l'ait décidé.
 */
export async function DeliverabilitySkipped({
  skipped,
}: {
  skipped: SkipCount[];
}): Promise<ReactElement> {
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const format = createFormat(locale);

  /**
   * Un motif inconnu s'affiche TEL QUEL — même dégradation que la carte de fil
   * du client. Le moteur d'envoi peut écrire un code que le catalogue de
   * traduction n'a pas encore : préférer le code brut à une clé manquante,
   * qui ferait tomber toute la page pour un mot.
   */
  const reasonText = (reason: string): string =>
    t.has(`deliverability.skipped.r.${reason}`)
      ? t(`deliverability.skipped.r.${reason}`)
      : reason;

  return (
    <section className="space-y-2">
      <div className="space-y-1">
        <h2 className="font-heading text-base font-medium">
          {t("deliverability.skipped.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("deliverability.skipped.hint")}</p>
      </div>

      {skipped.length === 0 ? (
        <Card className="shadow-xs">
          <CardContent>
            <p className="text-sm text-muted-foreground">{t("deliverability.skipped.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="hidden md:block">
            <Card className="shadow-xs">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("deliverability.skipped.reason")}</TableHead>
                      <TableHead className="text-right">
                        {t("deliverability.skipped.count")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {skipped.map((row) => (
                      <TableRow key={row.reason}>
                        <TableCell>{reasonText(row.reason)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {format(row.messages, "count")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-2 md:hidden">
            {skipped.map((row) => (
              <Card key={row.reason} size="sm" className="shadow-xs">
                <CardContent className="flex items-center justify-between gap-3">
                  <span className="min-w-0 text-sm">{reasonText(row.reason)}</span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {format(row.messages, "count")}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
