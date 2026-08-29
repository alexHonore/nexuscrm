import "server-only";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { runAfterResponse } from "@/lib/after-response";
import { fanoutPush, type PushableRow } from "@/lib/push/fanout";

/**
 * Le point de passage OBLIGÉ d'une notification.
 *
 * Avant lui, `db.insert(notifications)` était appelé depuis onze endroits dans
 * neuf fichiers : quatre aides locales sans lien entre elles et sept insertions
 * nues. Brancher la poussée sur chacune, c'était onze occasions d'en oublier
 * une — et l'oubli ne se serait pas vu, puisqu'une notification manquante ne
 * casse rien : elle se contente de ne jamais arriver. « Les appels manqués
 * réveillent le téléphone mais pas les nouveaux prospects » est exactement le
 * genre de panne qu'on ne diagnostique jamais, parce que personne ne remarque
 * ce qui n'a pas sonné.
 *
 * La règle est donc simple et vérifiée par `tests/unit-notify-chokepoint.test.ts` :
 * plus personne n'insère dans `notifications` sans passer par ici.
 *
 * La poussée part APRÈS la réponse. Un envoi vers APNs se compte en secondes,
 * et le webhook Twilio qui vient de déclencher la notification a une patience
 * mesurée : le faire attendre le ferait re-livrer, donc dupliquer la ligne.
 */

export type NotificationInsert = {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
};

type Tx = Pick<typeof db, "insert">;

/**
 * Écrit les lignes et réveille les téléphones.
 *
 * `tx` sert aux producteurs qui écrivent DANS une transaction (la synchro CDR
 * enveloppe toute sa réconciliation). Dans ce cas la poussée n'est PAS
 * programmée ici, et ce n'est pas un oubli : `runAfterResponse` démarre le
 * travail TOUT DE SUITE (il confie une promesse déjà lancée à `after()`), donc
 * une poussée programmée depuis l'intérieur d'une transaction partirait avant
 * le `commit` — et annoncerait des appels manqués qu'un `rollback` effacerait
 * ensuite. Une notification livrée ne se rappelle pas.
 *
 * Le contrat ne repose donc pas sur la mémoire de l'appelant : passer `tx`
 * SUFFIT à couper la poussée, sans qu'il ait à penser à l'éteindre. À lui de
 * garder ses lignes et d'appeler `fanoutPush(rows)` une fois la transaction
 * refermée — c'est ce que fait `src/lib/cdr-sync.ts`, le seul producteur dans
 * ce cas.
 */
export async function createNotifications(
  rows: NotificationInsert[],
  opts: { tx?: Tx; push?: boolean } = {},
): Promise<number> {
  if (rows.length === 0) return 0;

  const values = rows.map((row) => ({
    userId: row.userId,
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    link: row.link ?? null,
  }));

  const writer = opts.tx ?? db;
  await writer.insert(notifications).values(values);

  // Dans une transaction, jamais : voir plus haut. L'appelant pousse après le
  // `commit`. Le drapeau explicite reste possible pour les rares écritures
  // qu'on veut muettes (reprise, rattrapage, import).
  if (opts.push === false || opts.tx) return values.length;

  const pushable: PushableRow[] = values;
  runAfterResponse(async () => {
    await fanoutPush(pushable);
  });

  return values.length;
}

/** Le cas d'une seule ligne — de loin le plus courant. */
export async function createNotification(
  row: NotificationInsert,
  opts: { tx?: Tx; push?: boolean } = {},
): Promise<number> {
  return createNotifications([row], opts);
}
