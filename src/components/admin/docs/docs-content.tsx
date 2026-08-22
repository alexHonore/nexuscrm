import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CampaignFieldText } from "@/lib/campaigns/docs";
import type { ParamDocView } from "@/lib/docs-server";
import type { DocSection } from "@/lib/docs/types";
import type { FixtureFieldText, GuardrailKindText, SeverityText } from "@/lib/guardrails/docs";
import type { QuietHours } from "@/lib/sms/quiet-hours";
import { TriggerIcon } from "../trigger-look";
import { CopyButton } from "./copy-button";
import { DocsToc, type TocEntry } from "./toc";

/**
 * Contenu de la page de documentation — composant SYNCHRONE, sans accès aux
 * données : tout lui arrive en props (textes du namespace, registres, exemples
 * générés). C'est ce qui permet de le rendre dans un test avec les vrais
 * messages, et de garantir qu'aucune clé n'y manque.
 */

export interface DocsLabels {
  title: string;
  subtitle: string;
  toc: string;
  onThisPage: string;
  copy: string;
  copied: string;
  download: string;
  columns: Record<
    | "path" | "type" | "default" | "allowed" | "what" | "why" | "effect" | "pitfalls" | "binding"
    | "when" | "config" | "passes" | "caught" | "cost" | "yes" | "no" | "none" | "field" | "example"
    | "tool" | "modelSees",
    string
  >;
  overview: { title: string; p1: string; p2: string; steps: { title: string; items: string[] } };
  create: { title: string; p1: string; p2: string };
  triggers: {
    title: string;
    p1: string;
    kinds: Record<"manual" | "lead_created" | "category_changed" | "scheduled", string>;
    ladder: string;
    ab: string;
    caps: string;
  };
  assistants: { title: string; p1: string; overridden: string; sections: Record<DocSection, string> };
  guardrails: {
    title: string;
    p1: string;
    p2: string;
    p3: string;
    kindsTitle: string;
    severitiesTitle: string;
    fixturesTitle: string;
  };
  tools: { title: string; p1: string; gloss: Record<string, string> };
  sending: {
    title: string;
    consent: { title: string; p: string };
    optout: { title: string; p: string; keywords: string };
    quiet: { title: string; p: string; weekday: string; saturday: string; sunday: string };
    modes: { title: string; p: string };
    segments: { title: string; p: string };
  };
  operator: {
    title: string;
    p1: string;
    actions: string[];
    admin: { title: string; numbers: string; killSwitch: string; consentPolicy: string };
  };
  json: {
    title: string;
    p1: string;
    rule: { title: string; p: string };
    never: { title: string; items: string[] };
    structure: { title: string; rows: Record<string, string> };
    howExport: { title: string; items: string[] };
    howImport: { title: string; items: string[] };
    team: { title: string; p: string };
    exampleAssistant: string;
    exampleCampaign: string;
    campaignFields: { title: string; p: string };
  };
  golive: { title: string; p1: string; checks: string };
}

/**
 * Les registres arrivent DÉJÀ traduits : la page les résout dans la langue de
 * la requête et ce composant n'a plus qu'à les rendre. C'est ce qui garde le
 * rendu synchrone et testable avec les vrais messages, dans les deux langues.
 */
export interface DocsData {
  params: ParamDocView[];
  campaignFields: (CampaignFieldText & { path: string; binding?: string })[];
  guardrailKinds: (GuardrailKindText & { kind: string; costsModelCall: boolean })[];
  severities: (SeverityText & { severity: string })[];
  fixtureFields: (FixtureFieldText & { key: string })[];
  tools: { name: string; description: string }[];
  optoutKeywords: string[];
  quietHours: QuietHours;
  goLiveChecks: { id: string; label: string; fix: string }[];
  examples: { assistant: string; campaign: string };
}

const SECTION_ORDER: DocSection[] = [
  "identity",
  "goal",
  "approach",
  "knowledge",
  "objections",
  "tools",
  "guardrails",
  "model",
  "prompt",
  "campaign",
];

export function DocsContent({ labels: L, data }: { labels: DocsLabels; data: DocsData }) {
  const toc: TocEntry[] = [
    { id: "overview", label: L.overview.title },
    { id: "create", label: L.create.title },
    { id: "triggers", label: L.triggers.title },
    { id: "assistants", label: L.assistants.title },
    { id: "guardrails", label: L.guardrails.title },
    { id: "tools", label: L.tools.title },
    { id: "sending", label: L.sending.title },
    { id: "operator", label: L.operator.title },
    { id: "json", label: L.json.title },
    { id: "golive", label: L.golive.title },
  ];

  const bySection = new Map<DocSection, ParamDocView[]>();
  for (const p of data.params) {
    const list = bySection.get(p.section) ?? [];
    list.push(p);
    bySection.set(p.section, list);
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside>
        <DocsToc entries={toc} title={L.onThisPage} />
      </aside>

      <div className="min-w-0 space-y-12">
        {/* ── 1. Vue d'ensemble ─────────────────────────────────────────── */}
        <Section id="overview" title={L.overview.title} index={1}>
          <P>{L.overview.p1}</P>
          <P>{L.overview.p2}</P>
          <h3 className="mt-4 font-medium">{L.overview.steps.title}</h3>
          <ol className="mt-2 space-y-2">
            {L.overview.steps.items.map((item, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
                  {i + 1}
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
        </Section>

        {/* ── 2. Création ─────────────────────────────────────────────── */}
        <Section id="create" title={L.create.title} index={2}>
          <P>{L.create.p1}</P>
          <P>{L.create.p2}</P>
        </Section>

        {/* ── 3. Déclencheurs ─────────────────────────────────────────── */}
        <Section id="triggers" title={L.triggers.title} index={3}>
          <P>{L.triggers.p1}</P>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {(["lead_created", "category_changed", "scheduled", "manual"] as const).map((kind) => (
              <li key={kind} className="flex items-start gap-2.5 rounded-lg border p-3 text-sm">
                <TriggerIcon kind={kind} />
                <span>{L.triggers.kinds[kind]}</span>
              </li>
            ))}
          </ul>
          <P>{L.triggers.ladder}</P>
          <P>{L.triggers.ab}</P>
          <P>{L.triggers.caps}</P>
        </Section>

        {/* ── 4. Paramètres d'assistant ───────────────────────────────── */}
        <Section id="assistants" title={L.assistants.title} index={4}>
          <P>{L.assistants.p1}</P>
          {SECTION_ORDER.filter((s) => (bySection.get(s) ?? []).length > 0).map((section) => (
            <div key={section} className="mt-6">
              <h3 className="mb-2 font-medium">{L.assistants.sections[section]}</h3>
              <div className="space-y-3">
                {(bySection.get(section) ?? []).map((doc) => (
                  <article key={doc.path} className="rounded-lg border p-3 text-sm">
                    <header className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{doc.label}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{doc.path}</code>
                      <Badge variant="outline" className="text-[10px]">{doc.type}</Badge>
                      {doc.overridden ? (
                        <Badge variant="secondary" className="text-[10px]">{L.assistants.overridden}</Badge>
                      ) : null}
                    </header>
                    <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                      <Row k={L.columns.what} v={doc.what} />
                      <Row k={L.columns.why} v={doc.why} />
                      {doc.effect ? <Row k={L.columns.effect} v={doc.effect} /> : null}
                      {doc.pitfalls ? <Row k={L.columns.pitfalls} v={doc.pitfalls} /> : null}
                      {doc.defaultValue !== undefined ? (
                        <Row k={L.columns.default} v={<code className="font-mono text-xs">{JSON.stringify(doc.defaultValue)}</code>} />
                      ) : null}
                      {doc.allowed && doc.allowed.length > 0 ? (
                        <Row
                          k={L.columns.allowed}
                          v={
                            <ul className="space-y-0.5">
                              {doc.allowed.map((a) => (
                                <li key={String(a.value)}>
                                  <code className="font-mono text-xs">{JSON.stringify(a.value)}</code>{" "}
                                  <span className="text-muted-foreground">— {a.label}</span>
                                </li>
                              ))}
                            </ul>
                          }
                        />
                      ) : null}
                    </dl>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </Section>

        {/* ── 5. Garde-fous ───────────────────────────────────────────── */}
        <Section id="guardrails" title={L.guardrails.title} index={5}>
          <P>{L.guardrails.p1}</P>
          <P>{L.guardrails.p2}</P>
          <P>{L.guardrails.p3}</P>
          <h3 className="mt-4 font-medium">{L.guardrails.kindsTitle}</h3>
          <div className="mt-2 space-y-3">
            {data.guardrailKinds.map((k) => (
              <article key={k.kind} className="rounded-lg border p-3 text-sm">
                <header className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{k.label}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{k.kind}</code>
                  <Badge variant="outline" className="text-[10px]">
                    {L.columns.cost} : {k.costsModelCall ? L.columns.yes : L.columns.no}
                  </Badge>
                </header>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <Row k={L.columns.what} v={k.what} />
                  <Row k={L.columns.when} v={k.when} />
                  <Row k={L.columns.config} v={k.config} />
                  <Row k={L.columns.passes} v={k.passes} />
                  <Row k={L.columns.caught} v={k.caught} />
                  <Row k={L.columns.pitfalls} v={k.pitfall} />
                </dl>
              </article>
            ))}
          </div>
          <h3 className="mt-6 font-medium">{L.guardrails.severitiesTitle}</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {data.severities.map((s) => (
              <li key={s.severity} className="flex flex-wrap gap-2">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{s.severity}</code>
                <span className="font-medium">{s.label}</span>
                <span className="text-muted-foreground">— {s.what}</span>
              </li>
            ))}
          </ul>
          <h3 className="mt-6 font-medium">{L.guardrails.fixturesTitle}</h3>
          <div className="mt-2 space-y-2">
            {data.fixtureFields.map((f) => (
              <article key={f.key} className="rounded-lg border p-3 text-sm">
                <header className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{f.label}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{f.key}</code>
                </header>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <Row k={L.columns.what} v={f.what} />
                  <Row k={L.columns.example} v={f.example} />
                  <Row k={L.columns.pitfalls} v={f.pitfall} />
                </dl>
              </article>
            ))}
          </div>
        </Section>

        {/* ── 6. Outils ───────────────────────────────────────────────── */}
        <Section id="tools" title={L.tools.title} index={6}>
          <P>{L.tools.p1}</P>
          <div className="mt-3 space-y-3">
            {data.tools.map((tool) => (
              <article key={tool.name} className="rounded-lg border p-3 text-sm">
                <header className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{tool.name}</code>
                  <span>{L.tools.gloss[tool.name] ?? ""}</span>
                </header>
                <blockquote className="mt-2 border-l-2 pl-3 text-xs text-muted-foreground">
                  <span className="font-medium">{L.columns.modelSees} :</span> {tool.description}
                </blockquote>
              </article>
            ))}
          </div>
        </Section>

        {/* ── 7. Règles d'envoi ───────────────────────────────────────── */}
        <Section id="sending" title={L.sending.title} index={7}>
          <Sub title={L.sending.consent.title}>{L.sending.consent.p}</Sub>
          <Sub title={L.sending.optout.title}>
            {L.sending.optout.p}
            <p className="mt-2 text-xs font-medium text-muted-foreground">{L.sending.optout.keywords}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {data.optoutKeywords.map((k) => (
                <li key={k}>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{k}</code>
                </li>
              ))}
            </ul>
          </Sub>
          <Sub title={L.sending.quiet.title}>
            {L.sending.quiet.p}
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-3">
              <li>
                <span className="text-muted-foreground">{L.sending.quiet.weekday} :</span>{" "}
                {data.quietHours.weekday[0]} h – {data.quietHours.weekday[1]} h
              </li>
              <li>
                <span className="text-muted-foreground">{L.sending.quiet.saturday} :</span>{" "}
                {data.quietHours.saturday[0]} h – {data.quietHours.saturday[1]} h
              </li>
              <li>
                <span className="text-muted-foreground">{L.sending.quiet.sunday} :</span>{" "}
                {data.quietHours.sunday[0]} h – {data.quietHours.sunday[1]} h
              </li>
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">{data.quietHours.tz}</p>
          </Sub>
          <Sub title={L.sending.modes.title}>{L.sending.modes.p}</Sub>
          <Sub title={L.sending.segments.title}>{L.sending.segments.p}</Sub>
        </Section>

        {/* ── 8. Opérateur ────────────────────────────────────────────── */}
        <Section id="operator" title={L.operator.title} index={8}>
          <P>{L.operator.p1}</P>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm">
            {L.operator.actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
          <Sub title={L.operator.admin.title}>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>{L.operator.admin.numbers}</li>
              <li>{L.operator.admin.killSwitch}</li>
              <li>{L.operator.admin.consentPolicy}</li>
            </ul>
          </Sub>
        </Section>

        {/* ── 9. JSON ─────────────────────────────────────────────────── */}
        <Section id="json" title={L.json.title} index={9}>
          <P>{L.json.p1}</P>
          <div className="mt-3 rounded-lg border-2 border-primary/30 bg-primary/5 p-4">
            <h3 className="font-medium">{L.json.rule.title}</h3>
            <p className="mt-1 text-sm">{L.json.rule.p}</p>
          </div>
          <Sub title={L.json.never.title}>
            <ul className="list-disc space-y-1 pl-5">
              {L.json.never.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          </Sub>
          <Sub title={L.json.structure.title}>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
              {Object.entries(L.json.structure.rows).map(([key, text]) => (
                <Row key={key} k={<code className="font-mono text-xs">{key}</code>} v={text} />
              ))}
            </dl>
          </Sub>
          <Sub title={L.json.howExport.title}>
            <ol className="list-decimal space-y-1 pl-5">
              {L.json.howExport.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ol>
          </Sub>
          <Sub title={L.json.howImport.title}>
            <ol className="list-decimal space-y-1 pl-5">
              {L.json.howImport.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ol>
          </Sub>
          <Sub title={L.json.team.title}>{L.json.team.p}</Sub>

          <Example
            title={L.json.exampleAssistant}
            body={data.examples.assistant}
            href="/api/docs/examples/assistant"
            labels={L}
          />
          <Example
            title={L.json.exampleCampaign}
            body={data.examples.campaign}
            href="/api/docs/examples/campaign"
            labels={L}
          />

          <h3 className="mt-8 font-medium">{L.json.campaignFields.title}</h3>
          <p className="text-sm text-muted-foreground">{L.json.campaignFields.p}</p>
          <div className="mt-2 space-y-3">
            {data.campaignFields.map((f) => (
              <article key={f.path} className="rounded-lg border p-3 text-sm">
                <header className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{f.label}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{f.path}</code>
                  {f.binding ? (
                    <Badge variant="outline" className="text-[10px]">
                      {L.columns.binding} : {f.binding}
                    </Badge>
                  ) : null}
                </header>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <Row k={L.columns.what} v={f.what} />
                  <Row k={L.columns.why} v={f.why} />
                  {f.pitfalls ? <Row k={L.columns.pitfalls} v={f.pitfalls} /> : null}
                </dl>
              </article>
            ))}
          </div>
        </Section>

        {/* ── 10. Mise en service ─────────────────────────────────────── */}
        <Section id="golive" title={L.golive.title} index={10}>
          <P>{L.golive.p1}</P>
          <h3 className="mt-3 font-medium">{L.golive.checks}</h3>
          <ul className="mt-2 space-y-2">
            {data.goLiveChecks.map((c) => (
              <li key={c.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.label}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{c.id}</code>
                </div>
                {c.fix ? <p className="mt-1 text-muted-foreground">{c.fix}</p> : null}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  index,
  children,
}: {
  id: string;
  title: string;
  index: number;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
        <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
          {index}
        </span>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="font-medium">{title}</h3>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed">{children}</p>;
}

function Row({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </>
  );
}

function Example({
  title,
  body,
  href,
  labels,
}: {
  title: string;
  body: string;
  href: string;
  labels: DocsLabels;
}) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        <span className="flex-1" />
        <CopyButton text={body} label={labels.copy} done={labels.copied} />
        <Button variant="outline" size="sm" className="min-h-11 gap-1.5 md:min-h-8" render={<a href={href} download />}>
          <Download className="size-3.5" /> {labels.download}
        </Button>
      </div>
      <pre className="mt-2 max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {body}
      </pre>
    </div>
  );
}
