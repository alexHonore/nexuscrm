import "server-only";
import bcrypt from "bcryptjs";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Empreinte bcrypt (coût 12, comme `hashPassword`) d'un secret jeté après
 * coup : sert à comparer QUAND MÊME un mot de passe lorsque le compte n'existe
 * pas, pour que le temps de réponse ne trahisse pas l'existence d'une adresse.
 * Littéral figé : la recalculer à l'import coûterait ~300 ms à chaque démarrage.
 */
export const DUMMY_PASSWORD_HASH = "$2b$12$snipGV3ABFIzAaOOXwa3lu1GuP6kE.S0VHMIirjNWCnyEfh07dRUC";
