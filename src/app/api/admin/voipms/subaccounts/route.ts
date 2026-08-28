import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { getSubAccounts } from "@/lib/voipms";
import { readJson, toAdminUser, voipmsErrorResponse } from "../../_helpers";
import { indexBySipAccount, loadAssignments } from "../_assignments";
import { provisionSipLine, SIP_USERNAME_RE } from "../_provisioning";

/**
 * Liste les sous-comptes voip.ms annotés avec l'utilisateur qui les emploie
 * déjà (mêmes règles que les DID : un sous-compte = un téléphoniste).
 * Les sous-comptes libres sont remontés en tête.
 */
export async function GET() {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  try {
    const [accounts, assignments] = await Promise.all([getSubAccounts(), loadAssignments()]);
    const bySip = indexBySipAccount(assignments);

    const enriched = accounts.map((a) => {
      const holder =
        bySip.get(a.account.trim().toLowerCase()) ?? bySip.get(a.username.trim().toLowerCase()) ?? null;
      return {
        id: a.id,
        account: a.account,
        username: a.username,
        description: a.description,
        assignedUserId: holder?.id ?? null,
        assignedUserName: holder?.name ?? null,
        available: holder === null,
      };
    });

    enriched.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.account.localeCompare(b.account);
    });

    return NextResponse.json({
      accounts: enriched,
      availableCount: enriched.filter((a) => a.available).length,
      assignedCount: enriched.filter((a) => !a.available).length,
    });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}

const createSchema = z.object({
  userId: z.uuid(),
  /**
   * Absent ⇒ le nom est DÉRIVÉ du nom/courriel de la personne (configuration
   * automatique déclenchée juste après la création du compte).
   */
  username: z.string().trim().regex(SIP_USERNAME_RE).optional(),
});

/**
 * voip.ms est lent : on prend tout le budget d'exécution disponible. Si la
 * plateforme coupe quand même, le compte utilisateur reste créé et « Réessayer »
 * récupère la ligne (le provisionnement est idempotent).
 */
export const maxDuration = 60;

/**
 * Provisionne la ligne SIP d'un utilisateur : sous-compte voip.ms créé (ou
 * repris s'il existe déjà), mot de passe fort montré UNE fois et sauvegardé
 * chiffré sur l'utilisateur.
 *
 * Idempotent et auto-réparateur — voir `../_provisioning.ts`. Rejouer l'appel
 * (bouton « Réessayer ») est donc toujours sûr.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  const target = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const result = await provisionSipLine(target, body.username);

    await logAudit({
      userId: actor.user.id,
      action: "voipms.subaccount_create",
      entity: "user",
      entityId: target.id,
      detail: {
        account: result.account,
        created: result.created,
        derived: result.derived,
      },
    });

    const [updated] = await db.select().from(users).where(eq(users.id, target.id));
    return NextResponse.json({
      account: result.account,
      password: result.password,
      created: result.created,
      derived: result.derived,
      user: toAdminUser(updated),
    });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}
