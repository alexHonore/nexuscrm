import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/auth/guards";
import { getDids } from "@/lib/voipms";
import { voipmsErrorResponse } from "../../_helpers";

/** Liste les DID voip.ms (pour le sélecteur de numéro). */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  try {
    const dids = await getDids();
    return NextResponse.json({
      dids: dids.map((d) => ({
        did: d.did,
        description: d.description,
        routing: d.routing,
        state: d.state,
      })),
    });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}
