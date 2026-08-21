import { Rocket } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { GoLiveChecklist } from "@/components/admin/go-live-checklist";
import { PageHeader } from "@/components/shell/page-header";
import { requireAdmin } from "@/lib/auth/guards";
import { EngineReport } from "@/components/admin/engine-report";
import { collectPreflight } from "@/lib/golive-server";
import { engineSummary, perAssistant, perCampaign } from "@/lib/golive-server/reporting";

export default async function GoLivePage() {
  await requireAdmin();
  const t = await getTranslations("assistants");
  // Prêt-à-envoyer ET bilan sur le même écran : savoir si ça peut partir et
  // savoir si ça marche sont la même question, posée avant et après.
  const [report, summary, assistantRows, campaignRows] = await Promise.all([
    collectPreflight(),
    engineSummary(30),
    perAssistant(30),
    perCampaign(),
  ]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
      <PageHeader icon={<Rocket />} title={t("goLive.title")} subtitle={t("goLive.subtitle")} />
      <GoLiveChecklist report={report} />
      <EngineReport summary={summary} assistants={assistantRows} campaigns={campaignRows} />
    </div>
  );
}

/** L'état doit être frais : un contrôle mis en cache dirait « prêt » à tort. */
export const dynamic = "force-dynamic";
