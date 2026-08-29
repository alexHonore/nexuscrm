import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema-push";
import { apiActor } from "@/lib/permissions/server";
import { loadVapidKeys } from "@/lib/push/keys";
import { serializePushPayload } from "@/lib/push/payload";
import { sendPush } from "@/lib/push/send";

/**
 * POST /api/push/test — « est-ce que ça marche VRAIMENT ? »
 *
 * La chaîne compte huit maillons — clés VAPID, service worker enregistré,
 * permission accordée, abonnement écrit, chiffrement, APNs/FCM, gestionnaire
 * `push`, notification affichée — et chacun échoue en silence. Sans ce bouton,
 * la seule façon de découvrir qu'un maillon a cédé est de rater un vrai
 * prospect ; c'est trop tard et personne ne saura lequel.
 *
 * Volontairement borné aux appareils de CELUI qui appelle : une route capable
 * d'envoyer une notification à quelqu'un d'autre serait un mégaphone.
 * L'administrateur qui veut vérifier l'équipe regarde /admin/go-live, qui
 * COMPTE les appareils abonnés sans écrire à personne.
 */
export async function POST() {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;

  const keys = loadVapidKeys();
  if (!keys) return NextResponse.json({ error: "notConfigured" }, { status: 503 });

  const devices = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, actor.user.id));
  if (devices.length === 0) return NextResponse.json({ error: "noDevice" }, { status: 409 });

  const locale = actor.user.locale === "en" ? "en" : "fr";
  const payload = serializePushPayload({
    title: locale === "en" ? "Nexus — test" : "Nexus — essai",
    body:
      locale === "en"
        ? "Notifications are working on this device."
        : "Les notifications fonctionnent sur cet appareil.",
    url: "/notifications",
    tag: "nexus:test",
    type: "system",
  });

  const results = await Promise.all(
    devices.map((device) =>
      sendPush({
        subscription: { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        payload,
        // Zéro : un essai qui arrive dix minutes plus tard ne prouve rien et
        // fait douter du résultat qu'on vient d'observer.
        ttl: 0,
        urgency: "high",
        keys,
      }),
    ),
  );

  // Un appareil que le service déclare disparu part tout de suite : l'essai
  // sert autant à nettoyer qu'à vérifier.
  const gone = devices.filter((_, i) => {
    const r = results[i];
    return !r.ok && "gone" in r;
  });
  for (const device of gone) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
  }

  const sent = results.filter((r) => r.ok).length;
  return NextResponse.json({ ok: sent > 0, sent, pruned: gone.length, devices: devices.length });
}
