import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { calls, clients } from "@/db/schema";
import { apiUser } from "@/lib/auth/guards";
import { normalizePhone } from "@/lib/phone";
import { getSetting } from "@/lib/settings";

const createCallSchema = z.object({
  clientId: z.uuid().nullish(),
  direction: z.enum(["outbound", "inbound"]),
  toNumber: z.string().max(32).nullish(),
  fromNumber: z.string().max(32).nullish(),
  startedAt: z.coerce.date().optional(),
});

/**
 * POST /api/calls — ouvre une ligne de journal d'appel au moment où l'appel démarre.
 * La ligne est complétée (answeredAt/endedAt/disposition) via PATCH /api/calls/[id].
 */
export async function POST(req: NextRequest) {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const parsed = createCallSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;

  // clientId de confiance zéro : on vérifie qu'il existe, sinon on journalise sans fiche.
  let clientId: string | null = null;
  if (body.clientId) {
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, body.clientId),
      columns: { id: true },
    });
    clientId = client?.id ?? null;
  }

  const settings = await getSetting("telephony");

  const [row] = await db
    .insert(calls)
    .values({
      userId: auth.id,
      clientId,
      direction: body.direction,
      toNumber: normalizePhone(body.toNumber),
      fromNumber: normalizePhone(body.fromNumber),
      startedAt: body.startedAt ?? new Date(),
      provider: settings.provider,
    })
    .returning({ id: calls.id });

  return NextResponse.json({ id: row.id }, { status: 201 });
}
