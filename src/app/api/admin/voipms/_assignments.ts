import "server-only";
import { and, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * Rapprochement « ressource voip.ms ↔ utilisateur du CRM ».
 *
 * voip.ms renvoie les DID en chiffres bruts ("4184761542") alors que la base
 * stocke de l'E.164 ("+14184761542") : on compare toujours sur les 10 derniers
 * chiffres.
 */

export type AssignedUser = {
  id: string;
  name: string;
  email: string;
  sipUsername: string | null;
  didNumber: string | null;
};

/** Transaction Drizzle ou client racine — `releaseDidFromOthers` accepte les deux. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Clé de rapprochement d'un numéro : 10 derniers chiffres, ou null. */
export function didKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** Utilisateurs (id, nom, DID, sous-compte) pour annoter les listes voip.ms. */
export async function loadAssignments(): Promise<AssignedUser[]> {
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      sipUsername: users.sipUsername,
      didNumber: users.didNumber,
    })
    .from(users);
}

/** Index DID (10 chiffres) → utilisateur. */
export function indexByDid(list: AssignedUser[]): Map<string, AssignedUser> {
  const map = new Map<string, AssignedUser>();
  for (const u of list) {
    const key = didKey(u.didNumber);
    if (key && !map.has(key)) map.set(key, u);
  }
  return map;
}

/** Index sous-compte SIP (minuscules) → utilisateur. */
export function indexBySipAccount(list: AssignedUser[]): Map<string, AssignedUser> {
  const map = new Map<string, AssignedUser>();
  for (const u of list) {
    const key = u.sipUsername?.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, u);
  }
  return map;
}

/**
 * Retire le DID de tout AUTRE utilisateur qui le porterait — deux comptes ne
 * doivent jamais partager un numéro (identifiant d'appelant sortant et routage
 * entrant deviendraient ambigus). À appeler DANS la transaction qui assigne.
 *
 * La comparaison se fait sur les 10 derniers chiffres pour rattraper les
 * enregistrements d'un ancien format.
 */
export async function releaseDidFromOthers(
  tx: DbOrTx,
  didE164: string,
  keepUserId: string,
): Promise<{ id: string; name: string; email: string }[]> {
  const last10 = didKey(didE164);
  if (!last10) return [];
  return tx
    .update(users)
    .set({ didNumber: null, updatedAt: new Date() })
    .where(
      and(
        ne(users.id, keepUserId),
        isNotNull(users.didNumber),
        sql`right(regexp_replace(coalesce(${users.didNumber}, ''), '[^0-9]', '', 'g'), 10) = ${last10}`,
      ),
    )
    .returning({ id: users.id, name: users.name, email: users.email });
}
