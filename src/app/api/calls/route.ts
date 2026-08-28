import { and, eq, isNull, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { calls, clients, notifications } from "@/db/schema";
import {
  missedCallNotification,
  notificationContent,
} from "@/components/clients/notification-content";
import { logAudit } from "@/lib/audit";
import { apiActor, canSeeClient, grantsOnClient, verifyAssignment } from "@/lib/permissions/server";
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

/** La fiche réduite à ce qui décide de l'accès — plus son nom, pour la cloche. */
type CallClient = {
  id: string;
  fullName: string;
  assignedToId: string | null;
  lastContactedAt: Date | null;
  updatedAt: Date;
};

const CLIENT_COLUMNS = {
  id: true,
  fullName: true,
  assignedToId: true,
  lastContactedAt: true,
  updatedAt: true,
} as const;

/**
 * POST /api/calls — ouvre une ligne de journal d'appel au moment où l'appel démarre.
 * La ligne est complétée (answeredAt/endedAt/disposition) via PATCH /api/calls/[id].
 * Cas particulier : un entrant jamais décroché arrive déjà complet (endedAt sans
 * answeredAt) — on rattache la fiche client par numéro et on notifie l'usager
 * pour qu'il rappelle.
 *
 * Trois règles de droits se croisent ici, et elles ne disent pas la même chose :
 *
 *   1. Journaliser un appel, c'est APPELER : le droit `clients.call` est exigé,
 *      et la case « call » du compartiment quand un `clientId` est nommé.
 *   2. L'appel EXISTE — le téléphone a sonné. Il se journalise toujours : une
 *      fiche qui échappe à ce regard fait perdre le RATTACHEMENT, jamais la
 *      ligne. Ni 404 ni 403 sur une fiche invisible — les deux diraient qu'elle
 *      existe ; l'appel repart simplement sans fiche.
 *   3. Appeler une fiche du bassin la PREND (`claimOnCall`), quand la matrice
 *      permet à ce regard de se la prendre — c'est ce qui évite que deux
 *      téléphonistes appellent le même lead à trois minutes d'intervalle.
 *
 * La réponse porte `claimed` : c'est le seul signal qui dise à l'écran qu'une
 * fiche vient de changer de main sans que personne ne l'ait demandé (le toast
 * `clients.access.claimedOnCall`).
 */
export async function POST(req: NextRequest) {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;
  const user = actor.user;

  // Le droit d'appeler, avant toute chose. Refus franc : cet interrupteur ne
  // parle d'aucune fiche en particulier, il ne révèle donc rien.
  if (!actor.can("clients.call")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = createCallSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;

  const fromNumber = normalizePhone(body.fromNumber);
  const toNumber = normalizePhone(body.toNumber);

  // clientId de confiance zéro : on vérifie qu'il existe, sinon on journalise sans fiche.
  let client: CallClient | null = null;
  /** Le `clientId` reçu a été ÉCARTÉ : la fiche existe, mais pas pour ce regard. */
  let detached = false;
  if (body.clientId) {
    client =
      (await db.query.clients.findFirst({
        where: eq(clients.id, body.clientId),
        columns: CLIENT_COLUMNS,
      })) ?? null;
    if (client) {
      const grants = await grantsOnClient(actor, client);
      if (!grants.visible) {
        // Fiche invisible : elle se comporte comme une fiche ABSENTE. L'appel
        // reste journalisé — il a eu lieu — mais nu, et la réponse ne distingue
        // pas ce cas d'un identifiant inconnu.
        client = null;
        detached = true;
      } else if (!grants.call) {
        // Visible mais fermée à l'appel : refus explicite. Il ne dit rien que
        // l'écran ne montre déjà (la fiche, il la voit).
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
  }
  // Entrant sans fiche fournie : rattacher par numéro (même correspondance
  // souple que /api/clients/lookup — 10 derniers chiffres, phone ou phoneAlt).
  // Sauf si la fiche NOMMÉE vient d'être écartée : la rattraper par son numéro
  // rendrait le rattachement qu'on vient de retirer.
  if (!client && !detached && body.direction === "inbound") {
    const key = phoneMatchKey(fromNumber);
    if (key) {
      client =
        (await db.query.clients.findFirst({
          where: sql`
            RIGHT(REGEXP_REPLACE(${clients.phone}, '[^0-9]', '', 'g'), 10) = ${key}
            OR RIGHT(REGEXP_REPLACE(COALESCE(${clients.phoneAlt}, ''), '[^0-9]', '', 'g'), 10) = ${key}
          `,
          columns: CLIENT_COLUMNS,
        })) ?? null;
    }
  }

  // La fiche existe-t-elle POUR CE REGARD ? Question posée avant toute prise :
  // seule la notification d'appel manqué la nomme, et elle part sur un entrant,
  // jamais sur le sortant qui pourrait rendre la fiche visible en la prenant.
  const visible = client !== null && (await canSeeClient(actor, client));

  const settings = await getSetting("telephony");

  const durationSec =
    body.answeredAt && body.endedAt
      ? Math.max(0, Math.round((body.endedAt.getTime() - body.answeredAt.getTime()) / 1000))
      : undefined;

  // Le réglage global dit si le bureau le veut ; la matrice dit si CELUI-CI le
  // peut (droit d'assigner, case du compartiment, plafond de fiches détenues).
  // Sortant seulement : décrocher un entrant n'est pas se servir dans le bassin.
  const rules = actor.cfg.assignment;
  const claimTarget =
    rules.claimOnCall &&
    body.direction === "outbound" &&
    client !== null &&
    client.assignedToId === null &&
    (await verifyAssignment(actor, client, user.id)).ok;

  // TypeScript perd le rétrécissement d'un `let` capturé par une fermeture :
  // la constante le lui rend, sans quoi la transaction croit la fiche nulle.
  const target = client;
  const { callId, claimed } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(calls)
      .values({
        userId: user.id,
        clientId: target?.id ?? null,
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

    if (!claimTarget || !target) return { callId: row.id, claimed: false };

    // `assigned_to_id IS NULL` dans le WHERE, et non pas seulement dans le test
    // plus haut : deux téléphonistes qui composent le même lead à la même
    // seconde ne peuvent pas se le prendre tous les deux. Le perdant voit zéro
    // ligne modifiée — et son appel reste journalisé.
    const taken = await tx
      .update(clients)
      .set({ assignedToId: user.id, updatedAt: new Date() })
      .where(and(eq(clients.id, target.id), isNull(clients.assignedToId)))
      .returning({ id: clients.id });
    return { callId: row.id, claimed: taken.length > 0 };
  });

  const locale = user.locale === "en" ? "en" : "fr";

  if (claimed && client) {
    await logAudit({
      userId: user.id,
      action: "client.assign",
      entity: "client",
      entityId: client.id,
      // « D'où vient cette assignation » : personne ne l'a demandée à l'écran,
      // c'est le composeur qui l'a déclenchée. Sans ce détail, l'audit laisse
      // croire à un geste manuel.
      detail: { assignedToId: user.id, previous: null, source: "call", callId },
    });

    // « Prévenir la personne à qui la fiche est confiée » vaut aussi quand
    // c'est le composeur qui la lui a confiée : aucun clic ne l'a fait, la
    // cloche est la seule chose qui le dise. Corps vide à dessein — « X vous a
    // confié cette fiche » serait faux, X étant soi-même.
    if (rules.notifyAssignee) {
      await db.insert(notifications).values({
        userId: user.id,
        type: "assignment",
        title: notificationContent(locale, "clientAssignedTitle", { client: client.fullName }),
        body: null,
        link: `/clients/${client.id}`,
      });
    }
    // `notifyPreviousOwner` ne s'applique pas ici : une fiche du bassin n'a pas
    // d'ancien détenteur à prévenir.
  }

  // Appel manqué : notification de rappel pour le propriétaire de la ligne.
  // Sans accès à la fiche, elle ne porte que le NUMÉRO et mène au journal
  // d'appels — une notification est du contenu qui survit, et elle nommerait
  // pour toujours une fiche que l'écran refuse d'afficher.
  if (body.direction === "inbound" && !body.answeredAt && body.endedAt) {
    await db.insert(notifications).values(
      missedCallNotification({
        userId: user.id,
        locale,
        client: visible ? client : null,
        fromNumber,
      }),
    );
  }

  return NextResponse.json({ id: callId, claimed }, { status: 201 });
}
