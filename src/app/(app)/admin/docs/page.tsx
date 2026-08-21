import { BookOpenText } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { DocsContent, type DocsLabels } from "@/components/admin/docs/docs-content";
import { PageHeader } from "@/components/shell/page-header";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { requireAdmin } from "@/lib/auth/guards";
import { CAMPAIGN_FIELD_DOCS } from "@/lib/campaigns/docs";
import { getParamDocs } from "@/lib/docs-server";
import { exampleAssistantFile, exampleCampaignFile } from "@/lib/docs/examples";
import {
  FIXTURE_FIELD_DOCS,
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
} from "@/lib/guardrails/docs";
import { OPTOUT_KEYWORDS } from "@/lib/sms/optout";
import { DEFAULT_QUIET_HOURS } from "@/lib/sms/quiet-hours";

/**
 * /admin/docs — la documentation complète du moteur SMS et des assistants,
 * assemblée depuis les MÊMES registres que l'aide en ligne, les annotations
 * d'export et la page de mise en service. Rien n'y est écrit à la main qui
 * existe déjà ailleurs : quand un paramètre change, la page suit.
 */
export default async function AdminDocsPage() {
  await requireAdmin();
  const t = await getTranslations("assistants");
  const labels = t.raw("docs") as DocsLabels;
  const checks = t.raw("goLive.check") as Record<string, { label: string; fix: string }>;

  // Date fixe : les exemples affichés sont identiques d'une visite à l'autre.
  const now = new Date("2026-01-01T12:00:00.000Z");

  return (
    <div className="space-y-6">
      <PageHeader icon={<BookOpenText />} title={labels.title} subtitle={labels.subtitle} />
      <DocsContent
        labels={labels}
        data={{
          params: await getParamDocs(),
          campaignFields: CAMPAIGN_FIELD_DOCS,
          guardrailKinds: Object.values(GUARDRAIL_KIND_DOCS),
          severities: Object.values(GUARDRAIL_SEVERITY_DOCS),
          fixtureFields: FIXTURE_FIELD_DOCS,
          tools: Object.values(TOOL_DEFS).map((d) => ({ name: d.name, description: d.description })),
          optoutKeywords: [...OPTOUT_KEYWORDS],
          quietHours: DEFAULT_QUIET_HOURS,
          goLiveChecks: Object.entries(checks).map(([id, c]) => ({ id, label: c.label, fix: c.fix })),
          examples: { assistant: exampleAssistantFile(now), campaign: exampleCampaignFile(now) },
        }}
      />
    </div>
  );
}
