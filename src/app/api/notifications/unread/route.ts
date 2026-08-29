import { NextResponse } from "next/server";
import { apiActor } from "@/lib/permissions/server";
import { unreadCountFor } from "@/lib/push/fanout";
import { loadVapidKeys } from "@/lib/push/keys";

/**
 * GET /api/notifications/unread → { unread, vapidPublicKey }
 *
 * Le compteur le moins cher de l'application. La coquille rafraîchissait la
 * pastille avec un `router.refresh()` toutes les 30 secondes : un rendu RSC de
 * la route ENTIÈRE, sa requête de fiches comprise, pour lire un nombre. C'était
 * déjà le coût d'inactivité le plus lourd du produit ; sur un téléphone, en
 * données cellulaires, c'est aussi de la batterie.
 *
 * La clé publique VAPID voyage avec, et pas dans une variable
 * `NEXT_PUBLIC_*` : figée à la compilation, elle aurait obligé à reconstruire
 * pour la changer, et une clé de compilation qui ne correspond plus à la clé du
 * serveur produit des abonnements que rien ne peut plus atteindre — la panne la
 * plus silencieuse de tout ce chantier. Ici, elle est lue à chaque fois, du
 * même endroit que l'envoi. `null` signifie « la poussée n'est pas configurée »,
 * ce que l'écran des réglages sait dire.
 */
export async function GET() {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;

  const [unread, keys] = [await unreadCountFor(actor.user.id), loadVapidKeys()];

  return NextResponse.json(
    { unread, vapidPublicKey: keys?.publicKey ?? null },
    // Jamais de cache : c'est un compteur, et un compteur périmé fait ouvrir
    // une cloche vide — ou pire, laisse la pastille éteinte sur du non-lu.
    { headers: { "Cache-Control": "no-store" } },
  );
}
