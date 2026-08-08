import { asc, eq } from "drizzle-orm";
import { ArrowDownUp } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { ExportCard, ImportCard } from "@/components/admin/import-export-client";
import type { OptionDto } from "@/components/admin/types";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { categories, sources, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/guards";

export default async function AdminImportExportPage() {
  await requireAdmin();
  const [t, locale] = await Promise.all([getTranslations("admin"), getLocale()]);

  const [cats, srcs, activeUsers] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.query.users.findMany({ where: eq(users.isActive, true), orderBy: [asc(users.name)] }),
  ]);

  const categoryOptions: OptionDto[] = cats.map((c) => ({
    value: String(c.id),
    label: locale === "fr" ? c.nameFr : c.nameEn,
  }));
  const sourceOptions: OptionDto[] = srcs.map((s) => ({ value: String(s.id), label: s.name }));
  const userOptions: OptionDto[] = activeUsers.map((u) => ({ value: u.id, label: u.name }));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <PageHeader
        icon={<ArrowDownUp />}
        title={t("importExport.title")}
        subtitle={t("importExport.subtitle")}
      />
      <ImportCard categories={categoryOptions} sources={sourceOptions} users={userOptions} />
      <ExportCard categories={categoryOptions} sources={sourceOptions} users={userOptions} />
    </div>
  );
}
