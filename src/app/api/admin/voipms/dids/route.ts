import { NextResponse } from "next/server";
import { apiPerm } from "@/lib/permissions/server";
import { normalizePhone } from "@/lib/phone";
import { getDids } from "@/lib/voipms";
import { voipmsErrorResponse } from "../../_helpers";
import { didKey, indexByDid, loadAssignments } from "../_assignments";

/**
 * Liste les DID voip.ms annotés avec leur affectation dans le CRM :
 * qui détient le numéro, quel sous-compte SIP, et s'il est libre.
 * Les numéros disponibles sont remontés en tête.
 */
export async function GET() {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  try {
    const [dids, assignments] = await Promise.all([getDids(), loadAssignments()]);
    const byDid = indexByDid(assignments);

    const enriched = dids.map((d) => {
      const key = didKey(d.did);
      const holder = key ? (byDid.get(key) ?? null) : null;
      return {
        did: d.did,
        /** E.164 prêt à enregistrer sur l'utilisateur (la base ne stocke que ça). */
        e164: normalizePhone(d.did),
        description: d.description,
        /** Routage voip.ms brut, ex. "account:551013_alex" ou "account:551013". */
        routing: d.routing,
        state: d.state,
        assignedUserId: holder?.id ?? null,
        assignedUserName: holder?.name ?? null,
        assignedSipUsername: holder?.sipUsername ?? null,
        available: holder === null,
      };
    });

    // Disponibles d'abord, puis par numéro croissant.
    enriched.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.did.localeCompare(b.did);
    });

    return NextResponse.json({
      dids: enriched,
      availableCount: enriched.filter((d) => d.available).length,
      assignedCount: enriched.filter((d) => !d.available).length,
    });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}
