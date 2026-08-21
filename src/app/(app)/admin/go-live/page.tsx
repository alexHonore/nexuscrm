import { Rocket } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { GoLiveChecklist } from "@/components/admin/go-live-checklist";
import { PageHeader } from "@/components/shell/page-header";
import { requireAdmin } from "@/lib/auth/guards";
import { collectPreflight } from "@/lib/golive-server";

export default async function GoLivePage() {
  await requireAdmin();
  const t = await getTranslations("assistants");
  const report = await collectPreflight();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
      <PageHeader icon={<Rocket />} title={t("goLive.title")} subtitle={t("goLive.subtitle")} />
      <GoLiveChecklist report={report} />
    </div>
  );
}

/** L'état doit être frais : un contrôle mis en cache dirait « prêt » à tort. */
export const dynamic = "force-dynamic";
