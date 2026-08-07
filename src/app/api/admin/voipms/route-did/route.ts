import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { normalizePhone } from "@/lib/phone";
import { routeDidToSubAccount, updateSubAccountCallerId } from "@/lib/voipms";
import { readJson, voipmsErrorResponse } from "../../_helpers";
import { releaseDidFromOthers } from "../_assignments";

const schema = z.object({
  did: z.string().trim().min(7).max(32),
  /** Nom complet du sous-compte voip.ms ("compte_sousnom"). */
  account: z.string().trim().min(1).max(64),
  /** Si fourni, le DID (E.164) est aussi enregistré sur l'utilisateur. */
  userId: z.uuid().optional(),
});

/** Route un DID vers un sous-compte (setDIDRouting) + met à jour l'utilisateur. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const didE164 = normalizePhone(body.did);
  if (!didE164) return NextResponse.json({ error: "invalid_did" }, { status: 422 });

  try {
    await routeDidToSubAccount(body.did, body.account);
  } catch (err) {
    return voipmsErrorResponse(err);
  }

  // Le caller ID du sous-compte doit suivre le DID, sinon les appels sortants
  // partent sans numéro présenté valide (rejets possibles côté opérateur).
  // Meilleur effort : l'échec n'annule pas l'attribution, mais il est signalé.
  let calleridUpdated = true;
  try {
    await updateSubAccountCallerId(body.account, didE164.replace(/\D/g, "").slice(-10));
  } catch {
    calleridUpdated = false;
  }

  // Un DID n'appartient qu'à une personne : on le retire de son détenteur
  // précédent dans la MÊME transaction que l'assignation.
  let released: { id: string; name: string; email: string }[] = [];
  if (body.userId) {
    const userId = body.userId;
    released = await db.transaction(async (tx) => {
      const freed = await releaseDidFromOthers(tx, didE164, userId);
      await tx
        .update(users)
        .set({ didNumber: didE164, updatedAt: new Date() })
        .where(eq(users.id, userId));
      return freed;
    });
  }

  await logAudit({
    userId: admin.id,
    action: "voipms.did_route",
    entity: "user",
    entityId: body.userId,
    detail: {
      did: didE164,
      account: body.account,
      calleridUpdated,
      ...(released.length > 0 ? { releasedFrom: released } : {}),
    },
  });

  return NextResponse.json({ ok: true, did: didE164, released, calleridUpdated });
}
