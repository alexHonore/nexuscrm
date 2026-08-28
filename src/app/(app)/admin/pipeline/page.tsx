import { asc, count } from "drizzle-orm";
import { Workflow } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { CategoriesCard, SourcesCard } from "@/components/admin/pipeline-client";
import type { CategoryDto, SourceDto } from "@/components/admin/types";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { categories, clients, sources } from "@/db/schema";
import { requirePerm } from "@/lib/permissions/server";

export default async function AdminPipelinePage() {
  await requirePerm("admin.pipeline");
  const t = await getTranslations("admin");

  const [cats, srcs, catCounts, srcCounts] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.select({ id: clients.categoryId, n: count() }).from(clients).groupBy(clients.categoryId),
    db.select({ id: clients.sourceId, n: count() }).from(clients).groupBy(clients.sourceId),
  ]);

  const catCountMap = new Map(catCounts.map((c) => [c.id, c.n]));
  const srcCountMap = new Map(srcCounts.map((s) => [s.id, s.n]));

  const categoryDtos: CategoryDto[] = cats.map((c) => ({
    id: c.id,
    key: c.key,
    nameFr: c.nameFr,
    nameEn: c.nameEn,
    color: c.color,
    sortOrder: c.sortOrder,
    isSystem: c.isSystem,
    clientCount: catCountMap.get(c.id) ?? 0,
  }));

  const sourceDtos: SourceDto[] = srcs.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    clientCount: srcCountMap.get(s.id) ?? 0,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <PageHeader
        icon={<Workflow />}
        title={t("pipeline.title")}
        subtitle={t("pipeline.subtitle")}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CategoriesCard initial={categoryDtos} />
        <SourcesCard initial={sourceDtos} />
      </div>
    </div>
  );
}
