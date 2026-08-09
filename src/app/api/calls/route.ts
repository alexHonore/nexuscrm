import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { calls, clients, notifications } from "@/db/schema";
import { missedCallNotification } from "@/components/clients/notification-content";
import { apiUser } from "@/lib/auth/guards";
import { normalizePhone, phoneMatchKey } from "@/lib/phone";
import { getSetting } from "@/lib/settings";

const createCallSchema = z.object({
  clientId: z.uuid().nullish(),
  direction: z.enum(["outbound", "inbound"]),
  toNumber: z.string().max(32).nullish(),
  fromNumber: z.string().max(32).nullish(),
  startedAt: z.coerce.date().optional(),
  // Appel manqué (entrant jamais décroché) : journalisé complet en une requête.
  answeredAt: z.coerce.date().nullish(),
  endedAt: z.coerce.date().nullish(),
});

/**
 * POST /api/calls — ouvre une ligne de journal d'appel au moment où l'appel démarre.
 * La ligne est complétée (answeredAt/endedAt/disposition) via PATCH /api/calls/[id].
 * Cas particulier : un entrant jamais décroché arrive déjà complet (endedAt sans
 * answeredAt) — on rattache la fiche client par numéro et on notifie l'usager
 * pour qu'il rappelle.
 */
export async function POST(req: NextRequest) {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const parsed = createCallSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;

  const fromNumber = normalizePhone(body.fromNumber);
  const toNumber = normalizePhone(body.toNumber);

  // clientId de confiance zéro : on vérifie qu'il existe, sinon on journalise sans fiche.
  let client: { id: string; fullName: string } | null = null;
  if (body.clientId) {
    client =
      (await db.query.clients.findFirst({
        where: eq(clients.id, body.clientId),
        columns: { id: true, fullName: true },
      })) ?? null;
  }
  // Entrant sans fiche fournie : rattacher par numéro (même correspondance
  // souple que /api/clients/lookup — 10 derniers chiffres, phone ou phoneAlt).
  if (!client && body.direction === "inbound") {
    const key = phoneMatchKey(fromNumber);
    if (key) {
      client =
        (await db.query.clients.findFirst({
          where: sql`
            RIGHT(REGEXP_REPLACE(${clients.phone}, '[^0-9]', '', 'g'), 10) = ${key}
            OR RIGHT(REGEXP_REPLACE(COALESCE(${clients.phoneAlt}, ''), '[^0-9]', '', 'g'), 10) = ${key}
          `,
          columns: { id: true, fullName: true },
        })) ?? null;
    }
  }

  const settings = await getSetting("telephony");

  const durationSec =
    body.answeredAt && body.endedAt
      ? Math.max(0, Math.round((body.endedAt.getTime() - body.answeredAt.getTime()) / 1000))
      : undefined;

  const [row] = await db
    .insert(calls)
    .values({
      userId: auth.id,
      clientId: client?.id ?? null,
      direction: body.direction,
      toNumber,
      fromNumber,
      startedAt: body.startedAt ?? new Date(),
      answeredAt: body.answeredAt ?? null,
      endedAt: body.endedAt ?? null,
      ...(durationSec !== undefined ? { durationSec } : {}),
      provider: settings.provider,
    })
    .returning({ id: calls.id });

  // Appel manqué : notification de rappel pour le propriétaire de la ligne.
  if (body.direction === "inbound" && !body.answeredAt && body.endedAt) {
    await db.insert(notifications).values(
      missedCallNotification({
        userId: auth.id,
        locale: auth.locale === "en" ? "en" : "fr",
        client,
        fromNumber,
      }),
    );
  }

  return NextResponse.json({ id: row.id }, { status: 201 });
}
