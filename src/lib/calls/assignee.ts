import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * Le détenteur d'une fiche, quand il existe ET qu'il est encore en service.
 *
 * Sert aux notifications d'appel manqué : « son » client vient d'appeler, il
 * doit l'apprendre même si la sonnerie est partie ailleurs. La règle de
 * composition, elle, vit dans `missedCallRows`
 * (`src/components/clients/notification-content.ts`) — pure, sans base, pour
 * que les quatre chemins d'appel partagent la même décision.
 *
 * Pourquoi filtrer sur `isActive` ICI plutôt que de laisser passer : une
 * notification écrite pour un compte désactivé n'est lue par personne, mais
 * elle est bel et bien poussée — l'abonnement du téléphone survit à la
 * désactivation du compte. Quelqu'un qui a quitté l'entreprise continuerait
 * donc de faire vibrer son téléphone au nom de clients qu'il ne suit plus.
 *
 * Une requête par appel manqué, et c'est assumé : un appel manqué est un
 * événement rare à l'échelle d'une requête HTTP. Les producteurs qui en
 * traitent des DIZAINES d'un coup (la synchro CDR) n'appellent pas cette
 * fonction — ils ont déjà l'annuaire en mémoire et résolvent le détenteur
 * eux-mêmes.
 */
export async function activeAssignee(
  assignedToId: string | null | undefined,
): Promise<{ id: string; locale: string } | null> {
  if (!assignedToId) return null;
  const row = await db.query.users.findFirst({
    where: and(eq(users.id, assignedToId), eq(users.isActive, true)),
    columns: { id: true, locale: true },
  });
  return row ?? null;
}
