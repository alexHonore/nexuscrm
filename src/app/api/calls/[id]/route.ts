import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { missedCallNotification } from "@/components/clients/notification-content";
import { db } from "@/db";
import { DISPOSITIONS, calls, categories, clients, followups } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify";
import { apiActor, canSeeClient, clientRef, grantsOnClient } from "@/lib/permissions/server";
import { notifyCategoryChanged } from "@/lib/campaigns-server/match";

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
 *
 * Deux propriétés, donc deux gardes, et elles ne portent pas sur la même chose :
 * l'appel est le sien (`calls.user_id`) — sans quoi rien ne s'écrit ; la FICHE,
 * elle, ne bouge que si son compartiment ouvre la case « catégorie ». Fermée,
 * l'appel est quand même classé (disposition + note sur la ligne d'appel) et la
 * fiche reste où elle est. Le second n'est pas impliqué par le premier — on
 * peut avoir appelé une fiche qui a changé de main depuis.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;
  const auth = actor.user;

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

  // Classer un appel écrit à DEUX endroits, et un seul des deux appartient à
  // la fiche : la disposition et la note se posent sur la LIGNE D'APPEL, le
  // statut du pipeline (catégorie, dernier contact, « ne plus appeler ») sur la
  // fiche. La case « catégorie » du compartiment ne commande donc que le
  // second : un téléphoniste qui décroche un entrant sur une fiche tenue par le
  // patron doit pouvoir dire ce qui s'est passé — sinon le seul témoignage de
  // l'échange se perd, et l'appel reste éternellement « sans résultat ».
  //
  // Fiche invisible, elle, reste « introuvable » : un refus confirmerait son
  // existence. La distinction ne renseigne personne — pour arriver ici avec une
  // fiche visible, il faut déjà la voir nommée dans son journal d'appels.
  let mayWriteClient = false;
  if (body.disposition && call.clientId) {
    const ref = await clientRef(call.clientId);
    const grants = ref ? await grantsOnClient(actor, ref) : null;
    if (!grants || !grants.visible) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // Programmer une relance est un geste de plus. Ici la fiche est visible :
    // un refus explicite ne révèle rien.
    if (body.followupDueAt && !grants.followup) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    mayWriteClient = grants.category;
  }

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

  // Changement de catégorie réellement appliqué — notifié APRÈS la transaction.
  // (`as` et non une annotation : TypeScript ne voit pas l'affectation dans la
  // fermeture et croirait la variable encore nulle après la transaction.)
  let categoryChange = null as { clientId: string; from: number | null; to: number } | null;

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
    // `mayWriteClient` est faux quand la case « catégorie » du compartiment est
    // fermée : la fiche ne bouge alors d'AUCUN champ (statut, dernier contact,
    // « ne plus appeler »), et c'est tout ce qui est refusé — l'appel, lui, est
    // déjà classé plus haut. La relance suit sa propre case, vérifiée avant.
    if (call.clientId) {
      const client = await tx.query.clients.findFirst({ where: eq(clients.id, call.clientId) });
      if (client) {
        if (mayWriteClient) {
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
          if (targetCategory && client.categoryId !== targetCategory.id) {
            categoryChange = { clientId: client.id, from: client.categoryId, to: targetCategory.id };
          }
        }

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

  // Les boutons d'après-appel SONT le pipeline : c'est ICI que le déclencheur
  // « changement de catégorie » des campagnes SMS doit partir, pas seulement
  // depuis la liste déroulante de l'en-tête. Après la transaction — une
  // campagne ne peut pas faire échouer le classement d'un appel.
  if (categoryChange !== null) {
    notifyCategoryChanged(categoryChange.clientId, categoryChange.from, categoryChange.to);
  }

  // Entrant qui DEVIENT manqué à la finalisation : décroché au moment même où
  // l'appelant raccrochait — le POST du décroché semblait répondu, c'est donc
  // ici que naît la notification de rappel. Une seule fois : la garde
  // !call.endedAt rend les rejeux du même PATCH inoffensifs.
  if (call.direction === "inbound" && !answeredAt && endedAt && !call.endedAt) {
    let client: { id: string; fullName: string } | null = null;
    if (call.clientId) {
      const row = await db.query.clients.findFirst({
        where: eq(clients.id, call.clientId),
        columns: { id: true, fullName: true, assignedToId: true },
      });
      // Une notification SURVIT à l'écran : elle ne nomme la fiche que si
      // celle-ci existe pour son destinataire. Sinon, le numéro seul et le
      // journal d'appels — même règle que POST /api/calls.
      client = row && (await canSeeClient(actor, row)) ? row : null;
    }
    await createNotification(
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
        // « Pourquoi la fiche n'a-t-elle pas bougé ? » — la trace le dit, sinon
        // l'audit montre un classement et un pipeline immobile sans explication.
        pipelineApplied: mayWriteClient,
      },
    });
  }

  return NextResponse.json({ ok: true, id: call.id });
}
