import { Radar } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { DeliverabilityFindings } from "@/components/admin/deliverability-findings";
import {
  DeliverabilityMetrics,
  DeliverabilityNumbers,
  DeliverabilitySkipped,
} from "@/components/admin/deliverability-metrics";
import { DeliverabilityTemplates } from "@/components/admin/deliverability-templates";
import { DeliverabilityTwilioCard } from "@/components/admin/deliverability-twilio-card";
import { LookIcon, VERDICT_LOOK, lookTint } from "@/components/look";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import { collectFacts } from "@/lib/deliverability-server";
import { assess } from "@/lib/deliverability/assess";
import { RANGE_DAYS, parseRangeDays } from "@/lib/deliverability/range";
import { docLocale } from "@/lib/docs/types";

/**
 * « Est-ce que mes SMS arrivent, et sinon qu'est-ce que je corrige ? »
 *
 * Tout est calculé au rendu, à chaque chargement : un écran de délivrabilité
 * mis en cache dirait « rien à signaler » avec les chiffres d'hier, le jour
 * même où un opérateur commence à filtrer. `force-dynamic` est donc une règle
 * de justesse, pas une commodité.
 *
 * La page est un COMPOSANT SERVEUR de bout en bout, sauf la carte Twilio :
 * neuf dixièmes de ce qu'on lit vient de la base (instantané) et n'a aucune
 * raison d'attendre un aller-retour réseau vers le fournisseur.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("admin");
  return { title: t("deliverability.title") };
}

/**
 * L'ancre est en FRANÇAIS et figée : elle finit dans l'URL, donc dans un
 * signet ou un lien collé dans une conversation. La renommer casserait des
 * liens que le CRM ne contrôle plus. La clé i18n, elle, reste anglaise comme
 * partout ailleurs dans `messages/`.
 */
/**
 * Le sommaire, dans l'ORDRE DE LA PAGE.
 *
 * Un sommaire qui ne suit pas le corps envoie la deuxième puce au troisième
 * bloc : on croit avoir mal cliqué, et on cesse de s'en servir. L'ordre est
 * donc celui du rendu, pas celui du fichier de traductions.
 */
const SECTIONS = [
  { anchor: "apercu", key: "overview" },
  { anchor: "contenu", key: "content" },
  { anchor: "numeros", key: "numbers" },
  { anchor: "gabarits", key: "templates" },
  { anchor: "twilio", key: "twilio" },
] as const;

/** `?days=` peut arriver répété (`?days=7&days=30`) — on lit la première valeur. */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function DeliverabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const t = await getTranslations("admin");
  const locale = await getLocale();

  const days = parseRangeDays(first(sp.days));
  // La LANGUE DE L'INTERFACE choisit les textes du registre de constats — ici
  // c'est bien le cookie qui tranche : ces phrases sont lues par le courtier,
  // pas écrites à un client (règle 2 de AGENTS.md).
  const report = assess(await collectFacts(days), docLocale(locale));

  const verdictLook = VERDICT_LOOK[report.verdict];
  const verdictTint = lookTint(verdictLook);

  return (
    <div className="space-y-5 p-4 md:p-6">
      <PageHeader
        icon={<Radar />}
        title={t("deliverability.title")}
        subtitle={t("deliverability.subtitle")}
      />

      {/* ── Le verdict ──
          La seule ligne que l'opérateur lit vraiment : est-ce que ça passe
          aujourd'hui. Le pictogramme et la teinte viennent du vocabulaire
          commun, et le MOT est écrit à côté — un daltonien, une capture
          d'écran en noir et blanc ou un œil pressé doivent tous lire la même
          chose. La teinte ne prend que le fond et la bordure : peindre la
          phrase entière en ambre la rendrait moins lisible, pas plus urgente. */}
      <div
        className="flex items-start gap-3 rounded-xl border p-4"
        style={{
          backgroundColor: verdictTint.backgroundColor,
          borderColor: verdictTint.borderColor,
        }}
      >
        <LookIcon look={verdictLook} />
        <div className="min-w-0 space-y-0.5">
          <p className="font-heading text-base font-semibold" style={{ color: verdictLook.color }}>
            {t(`deliverability.verdict.${report.verdict}`)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(`deliverability.verdictHint.${report.verdict}`)}
          </p>
        </div>
      </div>

      {/* ── Période ──
          Trois liens, aucun JavaScript : la page est déjà « force-dynamic »,
          donc changer de fenêtre est une navigation serveur ordinaire — qui a
          l'avantage de rester dans l'historique et de se partager telle quelle.
          `aria-current` double le contraste visuel : sur un lecteur d'écran,
          « bouton foncé » ne veut rien dire. */}
      <nav aria-labelledby="deliverability-period" className="flex flex-wrap items-center gap-2">
        <span id="deliverability-period" className="text-xs text-muted-foreground">
          {t("deliverability.period.label")}
        </span>
        {RANGE_DAYS.map((d) => (
          <Button
            key={d}
            variant={d === days ? "default" : "outline"}
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<Link href={`?days=${d}`} aria-current={d === days ? "page" : undefined} />}
          >
            {t(`deliverability.period.d${d}`)}
          </Button>
        ))}
      </nav>

      {report.empty ? (
        /* Rien n'est parti : ni tuiles, ni tableaux, ni gabarits.
           Un tableau de zéros et de tirets se lit « tout va bien » alors qu'il
           dit « je n'ai rien mesuré » — et c'est la confusion qui coûte le plus
           cher sur cet écran.

           Les CONSTATS restent, eux, et c'est tout l'intérêt : « aucun message
           envoyé » est le plus souvent la CONSÉQUENCE d'un répartiteur arrêté
           ou d'un interrupteur baissé. Les cacher laisserait un bandeau rouge
           sans la moindre explication — le pire des deux mondes. */
        <>
          <Card>
            <CardContent className="space-y-1">
              <p className="text-sm font-medium">{t("deliverability.states.empty")}</p>
              <p className="text-sm text-muted-foreground">
                {t("deliverability.states.emptyHint")}
              </p>
            </CardContent>
          </Card>
          {report.findings.length > 0 ? (
            <DeliverabilityFindings
              findings={report.findings}
              moreCount={report.moreFindings}
            />
          ) : null}
        </>
      ) : (
        <>
          {/* ── Sommaire ──
              Cinq ancres plutôt que cinq onglets : l'écran s'imprime, se fait
              défiler d'une main sur un téléphone, et une section masquée est
              une section qu'on ne lit jamais. Pas de pictogramme ici — aucune
              des cinq sections n'est un concept du vocabulaire commun, et en
              inventer un pour l'occasion créerait un doublon de sens. */}
          <nav
            aria-label={t("deliverability.title")}
            className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
          >
            <ul className="flex w-max min-w-full items-center gap-2">
              {SECTIONS.map((s) => (
                <li key={s.anchor}>
                  <Link
                    href={`#${s.anchor}`}
                    className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:min-h-8"
                  >
                    {t(`deliverability.tabs.${s.key}`)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* `scroll-mt` : l'en-tête mobile est collant, sans marge de défilement
              une ancre place le titre de section SOUS lui. */}
          <section
            id="apercu"
            aria-label={t("deliverability.tabs.overview")}
            className="scroll-mt-16 md:scroll-mt-4"
          >
            <DeliverabilityMetrics report={report} />
          </section>

          {/* Les constats AVANT les tableaux : la page répond « quoi corriger »,
              pas « voici des chiffres ». Les chiffres justifient le constat, ils
              ne le précèdent pas. */}
          <section
            id="contenu"
            aria-label={t("deliverability.tabs.content")}
            className="scroll-mt-16 md:scroll-mt-4"
          >
            <DeliverabilityFindings
              findings={report.findings}
              moreCount={report.moreFindings}
            />
          </section>

          {/* Le numéro expéditeur et ce qui n'est jamais parti se lisent
              ensemble : les deux répondent à « où est passé mon message », avec
              deux dénominateurs qu'il ne faut surtout pas additionner. */}
          <section
            id="numeros"
            aria-label={t("deliverability.tabs.numbers")}
            className="scroll-mt-16 space-y-4 md:scroll-mt-4"
          >
            <DeliverabilityNumbers report={report} />
            <DeliverabilitySkipped skipped={report.skipped} />
          </section>

          <section
            id="gabarits"
            aria-label={t("deliverability.tabs.templates")}
            className="scroll-mt-16 md:scroll-mt-4"
          >
            <DeliverabilityTemplates templates={report.templates} />
          </section>

          {/* Le seul îlot client de la page : les sondes Twilio passent par le
              réseau et peuvent mettre plusieurs secondes — ou ne jamais
              répondre. Tout ce qui précède est déjà à l'écran pendant ce
              temps-là. */}
          <section
            id="twilio"
            aria-label={t("deliverability.tabs.twilio")}
            className="scroll-mt-16 md:scroll-mt-4"
          >
            <DeliverabilityTwilioCard />
          </section>
        </>
      )}
    </div>
  );
}
