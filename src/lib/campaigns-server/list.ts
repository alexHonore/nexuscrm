import "server-only";
import { asc, desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaigns } from "@/db/schema-sms";

/**
 * La liste des campagnes avec ses quatre compteurs — inscrits, en cours,
 * réponses, arrêts.
 *
 * Les sous-requêtes sont écrites en SQL BRUT, qualificateurs explicites.
 * Dans la liste des champs d'un select, drizzle rend `${campaigns.id}` comme
 * « "id" » tout court ; à l'intérieur de la sous-requête, ce « "id" » se
 * résout sur campaign_enrollments — et chaque campagne affichait 0 inscrit
 * quelle que soit la réalité. Trouvé en comparant l'écran à la base.
 */
export interface CampaignListRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  trigger: unknown;
  updatedAt: Date;
  enrolled: number;
  active: number;
  replied: number;
  stopped: number;
}

const countWhere = (status: string) =>
  sql<number>`(select count(*)::int from campaign_enrollments e where e.campaign_id = campaigns.id and e.status = ${status})`;

export async function listCampaignsWithCounts(): Promise<CampaignListRow[]> {
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      description: campaigns.description,
      status: campaigns.status,
      trigger: campaigns.trigger,
      updatedAt: campaigns.updatedAt,
      enrolled: sql<number>`(select count(*)::int from campaign_enrollments e where e.campaign_id = campaigns.id)`,
      active: countWhere("active"),
      replied: countWhere("replied"),
      stopped: countWhere("stopped"),
    })
    .from(campaigns)
    .orderBy(desc(campaigns.updatedAt), asc(campaigns.name));
}
