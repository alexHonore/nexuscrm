import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { DevelopersContent } from "@/components/developers/developers-content";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { CAMPAIGN_FIELD_DOCS, campaignFieldText } from "@/lib/campaigns/docs";
import { API_ENDPOINTS, apiEndpointText, pageText } from "@/lib/docs/api";
import { exampleAssistantFile, exampleCampaignFile } from "@/lib/docs/examples";
import { docLocale } from "@/lib/docs/locale";
import { resolveParamDoc } from "@/lib/docs/locale";
import { listParamDocs } from "@/lib/docs/params";
import type { DocLocale } from "@/lib/docs/types";
import {
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
  kindText,
  severityText,
} from "@/lib/guardrails/docs";

/**
 * /developers — la référence publique, SANS connexion.
 *
 * Elle existe pour qu'un intégrateur puisse brancher n8n, un formulaire de
 * site web ou un outil maison sans qu'on lui ouvre d'abord un compte : la
 * moitié des questions qu'on recevait tenaient à ça.
 *
 * DEUX règles gouvernent cette page, et elles ne sont pas décoratives :
 *
 * 1. **Aucune lecture de base.** Tout vient des registres de code. En
 *    particulier, on appelle `listParamDocs()` et NON `getParamDocs()` : cette
 *    dernière fusionne les réécritures administrateur enregistrées en base,
 *    qui sont du texte interne écrit pour l'exploitant — le publier serait une
 *    fuite silencieuse, et personne ne la verrait passer.
 *
 * 2. **Rien qui ne soit un contrat.** On documente le webhook d'entrée et le
 *    format de configuration, pas les routes qui servent les écrans : celles-ci
 *    changent avec l'interface, et les publier promettrait une stabilité qu'on
 *    ne tiendra pas.
 */

export const metadata: Metadata = {
  title: "Référence développeurs",
  description:
    "Webhook d'entrée des leads et format de configuration des assistants IA du CRM Groupe Nexus.",
};

/**
 * Rendue à la demande — `headers()` (l'adresse de base) et `?lang=` en font une
 * page dynamique. Ça ne coûte rien : elle ne touche aucune base, tout son
 * contenu vient de registres compilés dans le paquet.
 */
export const dynamic = "force-dynamic";

export default async function DevelopersPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  // La langue suit le cookie de l'interface, mais `?lang=` la force : un
  // intégrateur arrive par un lien partagé, sans compte et sans cookie.
  const { lang } = await searchParams;
  const locale: DocLocale =
    lang === "en" || lang === "fr" ? lang : docLocale(await getLocale());

  const T = pageText(locale);
  // Le pied reprend les liens publics des autres pages : sans lui, la
  // référence est un cul-de-sac — on y arrive par un lien partagé et on n'a
  // aucun moyen de rejoindre le reste du site.
  const tLegal = await getTranslations("legal");

  // Date fixe : les exemples sont identiques d'une visite à l'autre, donc
  // comparables entre deux personnes qui lisent la page en même temps.
  const now = new Date("2026-01-01T12:00:00.000Z");

  return (
    <>
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 p-4 md:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sidebar-primary to-sidebar-ring text-sm font-bold text-sidebar-primary-foreground shadow-md ring-1 ring-white/10"
            >
              N
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold tracking-tight">
                Groupe Nexus
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">{T.title}</span>
            </span>
          </Link>
          <span className="flex-1" />
          {/* Un lien, pas un bouton : la page est statique et doit rester
              partageable dans la langue où on l'a lue. */}
          <nav aria-label={T.title} className="flex items-center gap-1 text-sm">
            <LangLink lang="fr" active={locale === "fr"} label="Français" />
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <LangLink lang="en" active={locale === "en"} label="English" />
          </nav>
        </div>
      </header>

      <main>
        <div className="mx-auto w-full max-w-6xl px-4 pt-8 md:px-6">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">{T.title}</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">{T.subtitle}</p>
        </div>

        <DevelopersContent
          text={T}
          data={{
            baseUrl: await baseUrl(),
            locale,
            endpoints: API_ENDPOINTS.map((e) => apiEndpointText(e, locale)),
            // `listParamDocs` — le registre NU. Voir la note en tête de fichier.
            params: listParamDocs().map((d) =>
              resolveParamDoc({ ...d, overridden: false }, locale),
            ),
            campaignFields: CAMPAIGN_FIELD_DOCS.map((f) => ({
              ...campaignFieldText(f, locale),
              path: f.path,
            })),
            guardrailKinds: Object.values(GUARDRAIL_KIND_DOCS).map((k) => ({
              ...kindText(k, locale),
              kind: k.kind,
            })),
            severities: Object.values(GUARDRAIL_SEVERITY_DOCS).map((s) => ({
              ...severityText(s, locale),
              severity: s.severity,
            })),
            tools: Object.values(TOOL_DEFS).map((d) => ({
              name: d.name,
              description: d.description,
            })),
            examples: {
              assistant: exampleAssistantFile(now, locale),
              campaign: exampleCampaignFile(now, locale),
            },
          }}
        />
      </main>

      <footer className="mt-6 border-t bg-muted/30">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground md:px-6">
          <span>© {new Date().getFullYear()} Groupe Nexus</span>
          <nav className="flex flex-wrap gap-4">
            <Link href="/privacy" className="hover:text-foreground hover:underline">
              {tLegal("privacy.short")}
            </Link>
            <Link href="/terms" className="hover:text-foreground hover:underline">
              {tLegal("terms.short")}
            </Link>
            <Link href="/login" className="hover:text-foreground hover:underline">
              {tLegal("backToApp")}
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}

function LangLink({ lang, active, label }: { lang: string; active: boolean; label: string }) {
  return (
    <Link
      href={`/developers?lang=${lang}`}
      aria-current={active ? "true" : undefined}
      className={
        active
          ? "flex min-h-11 items-center px-1 font-medium text-foreground"
          : "flex min-h-11 items-center px-1 text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </Link>
  );
}

/**
 * L'adresse à écrire dans les exemples.
 *
 * Prise sur la requête plutôt qu'écrite en dur : la même page sert l'instance
 * de production, une préproduction et un poste de développement, et une doc
 * qui affiche le mauvais domaine se copie-colle telle quelle.
 */
async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
