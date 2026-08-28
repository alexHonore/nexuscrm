import { Wallet } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { BillingClient } from "@/components/admin/billing-client";
import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/permissions/server";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("admin");
  return { title: t("billing.title") };
}

/**
 * Consommation et dépense voip.ms.
 *
 * Les chiffres viennent de voip.ms (CDR + solde) et non de la base : l'appel
 * est lent et faillible, donc il est fait par l'îlot client. La page s'affiche
 * tout de suite et l'admin voit le chargement — plutôt qu'un écran blanc de
 * plusieurs secondes à chaque changement de période.
 */
export default async function BillingPage() {
  await requirePerm("admin.billing");
  const t = await getTranslations("admin");

  return (
    <div className="space-y-5 p-4 md:p-6">
      <PageHeader icon={<Wallet />} title={t("billing.title")} subtitle={t("billing.subtitle")} />
      <BillingClient />
    </div>
  );
}
