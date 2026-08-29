import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema-push";
import { logAudit } from "@/lib/audit";
import { apiActor } from "@/lib/permissions/server";
import { fromBase64Url } from "@/lib/push/keys";

/**
 * POST /api/push/subscribe — « ce téléphone-ci veut être prévenu ».
 *
 * Rien ici n'est un droit de rôle : recevoir SES propres notifications ne se
 * mérite pas, cela découle d'être connecté. La garde est donc `apiActor()` et
 * l'abonnement est écrit pour l'acteur COURANT — jamais pour un identifiant
 * fourni par le client, qui ferait de cette route un moyen d'inscrire le
 * téléphone de quelqu'un d'autre.
 *
 * L'unicité porte sur l'`endpoint` : ré-abonner le même téléphone doit
 * RAFRAÎCHIR la ligne, pas en créer une deuxième — sinon chaque notification
 * partirait en double et le téléphoniste couperait tout au bout d'une journée.
 * Un endpoint qui change de propriétaire (téléphone prêté, compte partagé sur
 * un poste) suit son nouveau titulaire : c'est la seule lecture qui ne laisse
 * pas les notifications de l'un arriver chez l'autre.
 */

const bodySchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({
      // 65 octets une fois décodés (point non compressé), 16 pour le secret.
      // On valide la FORME ici plutôt qu'à l'envoi : une clé bancale acceptée
      // aujourd'hui ne se manifesterait que le jour d'une vraie notification,
      // sous la forme d'un silence.
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(100),
    }),
  }),
  label: z.string().max(80).optional(),
  /** Rempli par le service worker quand le navigateur a fait tourner ses clés. */
  previousEndpoint: z.string().url().max(2000).nullish(),
  display: z.enum(["standalone", "browser"]).optional(),
});

export async function POST(request: NextRequest) {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { subscription, label, previousEndpoint, display } = parsed.data;

  // Les longueurs se vérifient sur les OCTETS décodés, pas sur la chaîne :
  // base64url n'a pas de longueur fixe pour une même charge utile.
  try {
    if (fromBase64Url(subscription.keys.p256dh).length !== 65) throw new Error("p256dh");
    if (fromBase64Url(subscription.keys.auth).length !== 16) throw new Error("auth");
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;
  const now = new Date();

  // Rotation de clés : l'ancienne ligne s'en va, sinon deux endpoints
  // désignent le même téléphone et l'un des deux répondra 410 pour toujours.
  if (previousEndpoint && previousEndpoint !== subscription.endpoint) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, previousEndpoint));
  }

  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId: actor.user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
      label: label ?? null,
      display: display ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: actor.user.id,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
        ...(label ? { label } : {}),
        ...(display ? { display } : {}),
        // Un ré-abonnement est une preuve de vie : le compteur d'échecs repart
        // de zéro, sinon un téléphone tombé en panne de réseau une semaine
        // resterait marqué comme suspect à son retour.
        failureCount: 0,
        lastSeenAt: now,
      },
    })
    .returning({ id: pushSubscriptions.id });

  await logAudit({
    userId: actor.user.id,
    action: "push.subscribe",
    entity: "push_subscription",
    entityId: row?.id ?? null,
    // Jamais l'endpoint en entier : c'est un jeton d'envoi. Sa fin suffit à
    // reconnaître l'appareil dans un journal.
    detail: { tail: subscription.endpoint.slice(-12), userAgent, display: display ?? null },
  });

  return NextResponse.json({ ok: true, id: row?.id ?? null });
}

/** DELETE /api/push/subscribe?endpoint=… — « ce téléphone-ci ne veut plus rien ». */
export async function DELETE(request: NextRequest) {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;

  const endpoint = request.nextUrl.searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // La suppression est bornée à SES abonnements : sans le `and`, connaître
  // l'endpoint d'un collègue suffirait à le rendre sourd.
  const deleted = await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, actor.user.id)),
    )
    .returning({ id: pushSubscriptions.id });

  if (deleted.length > 0) {
    await logAudit({
      userId: actor.user.id,
      action: "push.unsubscribe",
      entity: "push_subscription",
      entityId: deleted[0].id,
      detail: { tail: endpoint.slice(-12) },
    });
  }

  // On répond « fait » même si rien n'existait : l'appareil voulait ne plus
  // recevoir, et c'est le cas. Distinguer renseignerait sur ce qui existe.
  return NextResponse.json({ ok: true });
}
