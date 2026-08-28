import { Columns3 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { requireActor } from "@/lib/permissions/server";
import {
  PipelineBoard,
  type MoveTargetData,
  type PipelineCardData,
  type PipelineColumnData,
} from "@/components/pipeline/board";
import { PageHeader } from "@/components/shell/page-header";
import { getBoardData, type BoardClientRow } from "./board-data";

/** Couleur neutre de la colonne « Sans catégorie ». */
const NO_CATEGORY_COLOR = "#94a3b8";

function toCard(c: BoardClientRow): PipelineCardData {
  return {
    id: c.id,
    fullName: c.fullName,
    // Coordonnées fermées : la carte ne porte pas de numéro, et elle DIT
    // pourquoi. La chaîne vide d'avant rendait « masqué » et « aucun numéro
    // enregistré » identiques à l'œil — et le composeur, lui, restait offert.
    phone: c.phone,
    contactHidden: c.contactHidden,
    city: c.city,
    nextFollowupAt: c.nextFollowupAt?.toISOString() ?? null,
    doNotCall: c.doNotCall,
    lastDisposition: c.lastDisposition,
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * /pipeline — tableau Kanban pour TOUS les utilisateurs authentifiés
 * (c'est la vue de travail des téléphonistes). Colonnes = catégories
 * (sortOrder), + « Sans catégorie » en fin quand de tels clients existent.
 *
 * Aucun droit particulier n'est exigé : le tableau est la vue de travail, et
 * ce qu'il montre est déjà borné par la portée du regard (getBoardData) — un
 * observateur y voit ses colonnes, vides de ce qui ne lui appartient pas.
 */
export default async function PipelinePage() {
  const actor = await requireActor();
  const [t, locale, board] = await Promise.all([
    getTranslations("pipeline"),
    getLocale(),
    getBoardData(actor),
  ]);

  const categoryName = (c: { nameFr: string; nameEn: string }) =>
    locale === "en" ? c.nameEn : c.nameFr;

  const columns: PipelineColumnData[] = board.categories.map((c) => ({
    id: c.id,
    name: categoryName(c),
    color: c.color,
    total: board.totals.get(c.id) ?? 0,
    cards: (board.clientsByCategory.get(c.id) ?? []).map(toCard),
  }));

  const uncategorizedTotal = board.totals.get(null) ?? 0;
  if (uncategorizedTotal > 0) {
    columns.push({
      id: null,
      name: t("board.noCategory"),
      color: NO_CATEGORY_COLOR,
      total: uncategorizedTotal,
      cards: (board.clientsByCategory.get(null) ?? []).map(toCard),
    });
  }

  const targets: MoveTargetData[] = [
    ...board.categories.map((c) => ({ id: c.id, name: categoryName(c), color: c.color })),
    { id: null, name: t("board.noCategory"), color: NO_CATEGORY_COLOR },
  ];

  const totalClients = [...board.totals.values()].reduce((sum, n) => sum + n, 0);

  return (
    <div className="space-y-4 py-6">
      <PageHeader
        className="px-4 md:px-8"
        icon={<Columns3 />}
        title={t("title")}
        subtitle={t("subtitle", { count: totalClients })}
      />
      <PipelineBoard initialColumns={columns} targets={targets} now={board.generatedAt} />
    </div>
  );
}
