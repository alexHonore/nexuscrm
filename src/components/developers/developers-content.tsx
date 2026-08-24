import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { CopyButton } from "@/components/admin/docs/copy-button";
import { DocsToc, type TocEntry } from "@/components/admin/docs/toc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApiEndpointText, PageText } from "@/lib/docs/api";
import { API_AUTH, curlExample } from "@/lib/docs/api";
import type { DocLocale, ResolvedParamDoc } from "@/lib/docs/types";
import type { CampaignFieldText } from "@/lib/campaigns/docs";
import type { GuardrailKindText, SeverityText } from "@/lib/guardrails/docs";

/**
 * Contenu de la référence développeurs — composant SYNCHRONE, sans accès aux
 * données : tout lui arrive en props, résolu dans une langue. C'est ce qui
 * permet de le rendre dans un test avec les vrais registres, et surtout ce qui
 * garantit qu'AUCUNE valeur de la base ne peut atterrir sur une page publique.
 */

export interface DevData {
  baseUrl: string;
  /** Langue résolue de la page — propage ?lang au lien vers la spec JSON. */
  locale: DocLocale;
  endpoints: ApiEndpointText[];
  params: ResolvedParamDoc[];
  campaignFields: (CampaignFieldText & { path: string })[];
  guardrailKinds: (GuardrailKindText & { kind: string })[];
  severities: (SeverityText & { severity: string })[];
  tools: { name: string; description: string }[];
  examples: { assistant: string; campaign: string };
}

export function DevelopersContent({ text: T, data }: { text: PageText; data: DevData }) {
  const toc: TocEntry[] = [
    { id: "start", label: T.sections.start },
    { id: "auth", label: T.sections.auth },
    { id: "endpoints", label: T.sections.endpoints },
    { id: "assistant", label: T.sections.assistant },
    { id: "campaign", label: T.sections.campaign },
    { id: "guardrails", label: T.sections.guardrails },
    { id: "tools", label: T.sections.tools },
    { id: "spec", label: T.sections.spec },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl gap-8 p-4 md:p-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="mb-6 lg:mb-0">
        <DocsToc entries={toc} title={T.toc} />
      </div>

      <div className="min-w-0 space-y-10">
        {/* ── Pour commencer ── */}
        <Section id="start" title={T.sections.start}>
          <p className="text-sm text-muted-foreground">{T.start.p1}</p>
          <p className="text-sm text-muted-foreground">{T.start.p2}</p>
          <Field label={T.start.baseUrl}>
            <Code>{data.baseUrl}</Code>
          </Field>
          {/* Ce que la page NE couvre pas : sans cette phrase, un intégrateur
              branche un outil sur une route d'écran et se fait casser au
              prochain déploiement. */}
          <Card className="border-l-[3px] border-l-primary">
            <CardHeader>
              <CardTitle>{T.scopeTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{T.scopeBody}</p>
            </CardContent>
          </Card>
        </Section>

        {/* ── Authentification ── */}
        <Section id="auth" title={T.sections.auth}>
          <p className="text-sm text-muted-foreground">{T.auth.p1}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Code>{`${API_AUTH.headerPrimary}: <clé>`}</Code>
            <Code>{API_AUTH.headerAlternate}</Code>
          </div>
          <p className="text-sm text-muted-foreground">{T.auth.p2}</p>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRoundIcon aria-hidden className="size-4 text-primary" />
                {T.auth.keyName}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{T.auth.howTo}</p>
            </CardContent>
          </Card>
        </Section>

        {/* ── Points d'entrée ── */}
        <Section id="endpoints" title={T.sections.endpoints}>
          {data.endpoints.map((ep) => (
            <Endpoint key={ep.id} ep={ep} text={T} baseUrl={data.baseUrl} />
          ))}
        </Section>

        {/* ── Configuration d'un assistant ── */}
        <Section id="assistant" title={T.sections.assistant}>
          <p className="text-sm text-muted-foreground">{T.assistant.p1}</p>
          <p className="text-sm text-muted-foreground">{T.assistant.p2}</p>
          <ParamTable params={data.params} text={T} />
          <Example title={T.assistant.example} body={data.examples.assistant} text={T} />
        </Section>

        {/* ── Configuration d'une campagne ── */}
        <Section id="campaign" title={T.sections.campaign}>
          <p className="text-sm text-muted-foreground">{T.campaign.p1}</p>
          <Table
            head={[T.columns.path, T.columns.what]}
            rows={data.campaignFields.map((f) => [<Mono key="p">{f.path}</Mono>, f.what])}
          />
          <Example title={T.campaign.example} body={data.examples.campaign} text={T} />
        </Section>

        {/* ── Garde-fous ── */}
        <Section id="guardrails" title={T.sections.guardrails}>
          <p className="text-sm text-muted-foreground">{T.guardrails.p1}</p>
          <Table
            head={[T.columns.kind, T.columns.what, T.columns.when]}
            rows={data.guardrailKinds.map((k) => [<Mono key="k">{k.kind}</Mono>, k.what, k.when])}
          />
          <Table
            head={[T.columns.kind, T.columns.what]}
            rows={data.severities.map((s) => [<Mono key="s">{s.severity}</Mono>, s.what])}
          />
        </Section>

        {/* ── Outils ── */}
        <Section id="tools" title={T.sections.tools}>
          <p className="text-sm text-muted-foreground">{T.tools.p1}</p>
          <Table
            head={[T.columns.tool, T.columns.what]}
            rows={data.tools.map((t) => [<Mono key="t">{t.name}</Mono>, t.description])}
          />
        </Section>

        {/* ── Spécification machine ── */}
        <Section id="spec" title={T.sections.spec}>
          <p className="text-sm text-muted-foreground">{T.spec.p1}</p>
          <a
            href={`/api/docs/public?lang=${data.locale}`}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            {T.spec.open}
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
        </Section>
      </div>
    </div>
  );
}

function Endpoint({
  ep,
  text: T,
  baseUrl,
}: {
  ep: ApiEndpointText;
  text: PageText;
  baseUrl: string;
}) {
  const curl = curlExample(ep, baseUrl);
  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="font-mono">{ep.method}</Badge>
          <Mono className="text-sm font-medium">{ep.path}</Mono>
        </div>
        <CardTitle className="mt-1">{ep.label}</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">{ep.what}</p>
        <p className="mt-1 text-sm text-muted-foreground">{ep.why}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field label={T.request}>
          <Table
            head={[T.fields.name, T.fields.aliases, T.fields.what]}
            rows={ep.fields.map((f) => [
              <span key="n" className="flex flex-wrap items-center gap-1.5">
                <Mono>{f.name}</Mono>
                <Badge variant={f.required ? "default" : "outline"} className="font-normal">
                  {f.required ? T.fields.required : T.fields.optional}
                </Badge>
              </span>,
              // Les alias ne sont pas du décor : c'est ce que Facebook envoie
              // réellement, et l'intégrateur les cherche mot pour mot.
              f.aliases.length > 0 ? (
                <span key="a" className="flex flex-wrap gap-1">
                  {f.aliases.map((a) => (
                    <Mono key={a} className="rounded bg-muted px-1 py-0.5 text-[11px]">
                      {a}
                    </Mono>
                  ))}
                </span>
              ) : (
                "—"
              ),
              f.what,
            ])}
          />
        </Field>

        <Field label={T.statuses}>
          <Table
            head={["", "", T.fields.what]}
            rows={ep.responses.map((r) => [
              <Badge
                key="s"
                variant={r.status < 300 ? "secondary" : "destructive"}
                className="font-mono"
              >
                {r.status}
              </Badge>,
              r.code ? <Mono key="c">{r.code}</Mono> : "—",
              r.what,
            ])}
          />
        </Field>

        <Field label={T.notes}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {ep.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Field>

        <Example title="curl" body={curl} text={T} />
        <Example title={T.response} body={JSON.stringify(ep.exampleResponse, null, 2)} text={T} />
      </CardContent>
    </Card>
  );
}

/**
 * Le tableau des paramètres d'assistant.
 *
 * Plus de cent lignes : elles sont GROUPÉES par section, comme les onglets de
 * l'éditeur. Une liste à plat de cent chemins ne se parcourt pas, elle se
 * cherche — et on ne sait pas quoi chercher la première fois.
 */
function ParamTable({ params, text: T }: { params: ResolvedParamDoc[]; text: PageText }) {
  const sections = [...new Set(params.map((p) => p.section))];
  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <div key={section} className="space-y-2">
          <h3 className="font-heading text-base font-semibold">{section}</h3>
          <Table
            head={[T.columns.path, T.columns.type, T.columns.default, T.columns.what]}
            rows={params
              .filter((p) => p.section === section)
              .map((p) => [
                <span key="p" className="flex flex-wrap items-center gap-1.5">
                  <Mono>{p.path}</Mono>
                  {p.required ? (
                    <Badge variant="outline" className="font-normal">
                      {T.fields.required}
                    </Badge>
                  ) : null}
                </span>,
                <span key="t" className="flex flex-col gap-1">
                  <Mono className="text-[11px]">{p.type}</Mono>
                  {p.allowed?.length ? (
                    <span className="flex flex-wrap gap-1">
                      {p.allowed.map((a) => (
                        <Mono
                          key={String(a.value)}
                          className="rounded bg-muted px-1 py-0.5 text-[11px]"
                        >
                          {String(a.value)}
                        </Mono>
                      ))}
                    </span>
                  ) : null}
                </span>,
                p.defaultValue === undefined ? "—" : <Mono key="d">{JSON.stringify(p.defaultValue)}</Mono>,
                p.what,
              ])}
          />
        </div>
      ))}
    </div>
  );
}

// ── Pièces communes ──────────────────────────────────────────────────────────

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4">
      <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={className ?? "font-mono text-xs"}>{children}</code>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">
      {children}
    </pre>
  );
}

/** Un bloc à copier : sans le bouton, on sélectionne à la souris et on rate une accolade. */
function Example({ title, body, text: T }: { title: string; body: string; text: PageText }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <CopyButton text={body} label={T.copy} done={T.copied} />
      </div>
      <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">
        {body}
      </pre>
    </div>
  );
}

/**
 * Un tableau qui devient des CARTES sous `md`.
 *
 * Une table de quatre colonnes sur un téléphone se lit en défilant
 * horizontalement, colonne par colonne : on perd la ligne qu'on suivait. La
 * même donnée empilée reste lisible.
 */
function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              {head.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, i) => (
              <tr key={i} className="align-top">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-2">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {rows.map((row, i) => (
          <li key={i} className="space-y-1.5 rounded-lg border p-3 text-sm">
            {row.map((cell, j) =>
              cell === "—" || cell === "" ? null : (
                <div key={j} className="space-y-0.5">
                  {head[j] ? (
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {head[j]}
                    </p>
                  ) : null}
                  <div>{cell}</div>
                </div>
              ),
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
