import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { missedCallNotification } from "@/components/clients/notification-content";
import { db } from "@/db";
import { DISPOSITIONS, calls, categories, clients, followups, notifications } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiUser } from "@/lib/auth/guards";

const patchCallSchema = z.object({
  answeredAt: z.coerce.date().nullish(),
  endedAt: z.coerce.date().nullish(),
  durationSec: z.number().int().min(0).max(60 * 60 * 24).optional(),
  // « no_answer », la clé d'une catégorie du pipeline, ou « cat:<id> » —
  // validée contre la table categories plus bas, pas par une liste figée.
  disposition: z.string().trim().min(1).max(64).optional(),
  note: z.string().max(4000).nullish(),
  followupDueAt: z.coerce.date().optional(),
});

/**
 * PATCH /api/calls/[id] — complète une ligne d'appel (durées) et/ou applique la
 * disposition d'après-appel. Chaque utilisateur ne peut toucher QUE ses propres
 * appels. La disposition est appliquée CÔTÉ SERVEUR dans une transaction :
 * depuis l'alignement du pipeline sur Notion, classer un appel = déplacer la
 * fiche dans le statut choisi (+ dernier contact, Ne plus appeler, relance).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = patchCallSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;

  // Propriété stricte : ses propres appels seulement.
  const call = await db.query.calls.findFirst({
    where: and(eq(calls.id, id), eq(calls.userId, auth.id)),
  });
  if (!call) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // ── Résolution du statut visé ──
  // « no_answer » ne déplace pas la fiche. Toute autre valeur doit être une
  // catégorie du pipeline (par clé, ou « cat:<id> » pour une catégorie sans
  // clé). Les 7 anciennes valeurs restent tolérées si leur catégorie a
  // disparu (vieil onglet ouvert pendant une refonte du pipeline) — l'appel
  // est alors classé sans effet sur le statut, comme avant.
  let targetCategory: { id: number; key: string | null } | null = null;
  if (body.disposition && body.disposition !== "no_answer") {
    // Borne int4 : un id hors plage ferait planter Postgres (500 au lieu de 400).
    const catRef = /^cat:([1-9]\d{0,9})$/.exec(body.disposition);
    const catId = catRef ? Number(catRef[1]) : null;
    if (catId !== null && catId > 2_147_483_647) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    targetCategory =
      (await db.query.categories.findFirst({
        where: catId !== null ? eq(categories.id, catId) : eq(categories.key, body.disposition),
        columns: { id: true, key: true },
      })) ?? null;
    if (!targetCategory && !(DISPOSITIONS as readonly string[]).includes(body.disposition)) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    // « Non contacté » après un appel terminé : non-sens — le popup l'exclut,
    // le serveur le refuse aussi (y compris via son alias « cat:<id> »).
    if (targetCategory?.key === "new") {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
  }

  const now = new Date();
  const answeredAt = body.answeredAt !== undefined ? body.answeredAt : call.answeredAt;
  const endedAt = body.endedAt !== undefined ? body.endedAt : call.endedAt;
  const durationSec =
    body.durationSec ??
    (answeredAt && endedAt
      ? Math.max(0, Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000))
      : undefined);

  await db.transaction(async (tx) => {
    await tx
      .update(calls)
      .set({
        ...(body.answeredAt !== undefined ? { answeredAt: body.answeredAt } : {}),
        ...(body.endedAt !== undefined ? { endedAt: body.endedAt } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(body.disposition !== undefined ? { disposition: body.disposition } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      })
      .where(eq(calls.id, call.id));

    if (!body.disposition) return;

    // Idempotence : si cette disposition est déjà posée sur l'appel (retry client
    // après réponse perdue), ne pas rejouer les effets (relance dupliquée, catégorie).
    if (call.disposition === body.disposition) return;

    // ── Effets pipeline sur la fiche client ──
    if (call.clientId) {
      const client = await tx.query.clients.findFirst({ where: eq(clients.id, call.clientId) });
      if (client) {
        await tx
          .update(clients)
          .set({
            lastDisposition: body.disposition,
            lastContactedAt: now,
            updatedAt: now,
            ...(targetCategory ? { categoryId: targetCategory.id } : {}),
            ...(targetCategory?.key === "dncl" ? { doNotCall: true } : {}),
          })
          .where(eq(clients.id, client.id));

        if (body.followupDueAt) {
          await tx.insert(followups).values({
            clientId: client.id,
            assignedToId: auth.id,
            dueAt: body.followupDueAt,
            note: body.note ?? null,
            createdById: auth.id,
          });
          if (!client.nextFollowupAt || body.followupDueAt < client.nextFollowupAt) {
            await tx
              .update(clients)
              .set({ nextFollowupAt: body.followupDueAt })
              .where(eq(clients.id, client.id));
          }
        }
      }
    }
  });

  // Entrant qui DEVIENT manqué à la finalisation : décroché au moment même où
  // l'appelant raccrochait — le POST du décroché semblait répondu, c'est donc
  // ici que naît la notification de rappel. Une seule fois : la garde
  // !call.endedAt rend les rejeux du même PATCH inoffensifs.
  if (call.direction === "inbound" && !answeredAt && endedAt && !call.endedAt) {
    let client: { id: string; fullName: string } | null = null;
    if (call.clientId) {
      client =
        (await db.query.clients.findFirst({
          where: eq(clients.id, call.clientId),
          columns: { id: true, fullName: true },
        })) ?? null;
    }
    await db.insert(notifications).values(
      missedCallNotification({
        userId: auth.id,
        locale: auth.locale === "en" ? "en" : "fr",
        client,
        fromNumber: call.fromNumber,
      }),
    );
  }

  if (body.disposition) {
    await logAudit({
      userId: auth.id,
      action: "call.disposition",
      entity: "call",
      entityId: call.id,
      detail: {
        disposition: body.disposition,
        clientId: call.clientId,
        followupDueAt: body.followupDueAt?.toISOString() ?? null,
      },
    });
  }

  return NextResponse.json({ ok: true, id: call.id });
}
