import { asc, eq } from "drizzle-orm";
import { ArrowDownUp } from "lucide-react";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ExportCard, ImportCard } from "@/components/admin/import-export-client";
import type { OptionDto } from "@/components/admin/types";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { categories, sources, users } from "@/db/schema";
import { requireActor } from "@/lib/permissions/server";

export default async function AdminImportExportPage() {
  // Un écran, DEUX droits : entrer des fiches et en sortir ne se confient pas
  // à la même personne. Chaque carte est donc gardée pour elle-même, et la
  // page ne s'ouvre que si au moins l'une des deux a de quoi s'afficher —
  // sinon elle ne montrerait qu'un titre et ses deux absences.
  const actor = await requireActor();
  const canImport = actor.can("clients.import");
  const canExport = actor.can("clients.export");
  if (!canImport && !canExport) redirect("/dashboard");

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
      {canImport && (
        <ImportCard categories={categoryOptions} sources={sourceOptions} users={userOptions} />
      )}
      {canExport && (
        <ExportCard categories={categoryOptions} sources={sourceOptions} users={userOptions} />
      )}
    </div>
  );
}
