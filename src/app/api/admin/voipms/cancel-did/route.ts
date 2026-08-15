import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { normalizePhone } from "@/lib/phone";
import { cancelDid, didDigits, getDids } from "@/lib/voipms";
import { readJson, voipmsErrorResponse } from "../../_helpers";
import { didKey } from "../_assignments";
import { withVoipTimeout } from "../_provisioning";

/**
 * Deux appels voip.ms enchaînés, chacun borné à 45 s : une limite plus basse
 * couperait la requête APRÈS la résiliation, qui est irréversible, et la
 * priverait de sa trace en base.
 */
export const maxDuration = 300;

const schema = z.object({
  did: z.string().trim().min(7).max(32),
  /**
   * Derniers chiffres SAISIS par l'admin (au moins 4). Renvoyer simplement le
   * numéro affiché ne prouverait rien : c'est une frappe volontaire qui protège
   * du clic sur la mauvaise ligne.
   */
  confirm: z.string().trim().min(4).max(32),
  comment: z.string().trim().max(200).optional(),
});

/** Les 4 derniers chiffres d'une saisie, ou null si elle n'en contient pas assez. */
function last4(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * RÉSILIE un numéro chez voip.ms : la facturation mensuelle s'arrête et le
 * numéro est PERDU (il retourne à l'inventaire public — on ne peut pas compter
 * le récupérer). Le détenteur éventuel perd son numéro dans la foulée.
 *
 * Irréversible, donc : double saisie du numéro, vérification qu'il appartient
 * bien au compte, et journal d'audit.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const didE164 = normalizePhone(body.did);
  if (!didE164) return NextResponse.json({ error: "invalid_did" }, { status: 422 });

  // La confirmation doit désigner LE MÊME numéro — un clic distrait ne doit
  // pas pouvoir résilier la ligne affichée juste à côté.
  const typed = last4(body.confirm);
  if (!typed || typed !== last4(didE164)) {
    return NextResponse.json({ error: "confirm_mismatch" }, { status: 422 });
  }

  try {
    // On ne résilie que ce que le compte possède vraiment : sans cette
    // vérification, une faute de frappe partirait chez voip.ms telle quelle.
    const owned = await withVoipTimeout(getDids());
    const wanted = didDigits(didE164);
    if (!owned.some((d) => didDigits(d.did) === wanted)) {
      return NextResponse.json({ error: "did_not_owned" }, { status: 404 });
    }

    await withVoipTimeout(cancelDid(didE164, body.comment));
  } catch (err) {
    return voipmsErrorResponse(err);
  }

  // Le numéro n'existe plus : personne ne doit continuer à l'afficher comme
  // identifiant d'appelant. Comparaison sur les 10 derniers chiffres pour
  // rattraper d'éventuels formats hérités.
  //
  // Le nettoyage ne doit PAS pouvoir empêcher la journalisation : la
  // résiliation est déjà faite chez voip.ms et elle est irréversible, donc
  // elle doit laisser une trace même si la base refuse la mise à jour.
  let released: { id: string; name: string; email: string }[] = [];
  let releaseFailed = false;
  try {
    released = await db
      .update(users)
      .set({ didNumber: null, updatedAt: new Date() })
      .where(
        sql`right(regexp_replace(coalesce(${users.didNumber}, ''), '[^0-9]', '', 'g'), 10) = ${didKey(didE164)}`,
      )
      .returning({ id: users.id, name: users.name, email: users.email });
  } catch {
    releaseFailed = true;
  }

  await logAudit({
    userId: admin.id,
    action: "voipms.did_cancel",
    entity: "user",
    entityId: released[0]?.id,
    detail: {
      did: didE164,
      releasedFrom: released,
      comment: body.comment ?? null,
      ...(releaseFailed ? { releaseFailed } : {}),
    },
  });

  return NextResponse.json({ ok: true, did: didE164, released, releaseFailed });
}
