import { and, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { requireActor, withVisibility } from "@/lib/permissions/server";
import { torontoDayRange } from "@/components/clients/timezone";
import { ClientLaunchpad } from "@/components/clients/client-launchpad";

/**
 * Desktop empty state of the master-detail workspace. On mobile the layout's
 * panel IS the page, so this renders nothing below md.
 *
 * Tous les compteurs comptent CE QUE CE REGARD VOIT. Un « 10 412 fiches »
 * affiché à un téléphoniste qui n'en atteint que 300 serait le seul endroit de
 * l'application où le chiffre caché se lit tout haut.
 */
export default async function ClientsPage() {
  const actor = await requireActor();

  const now = new Date();
  const { start, end } = torontoDayRange(now);
  const [total, overdue, today, never, none] = await Promise.all([
    db.$count(clients, await withVisibility(actor, undefined)),
    db.$count(
      clients,
      await withVisibility(actor, and(isNotNull(clients.nextFollowupAt), lt(clients.nextFollowupAt, now))),
    ),
    db.$count(
      clients,
      await withVisibility(actor, and(gte(clients.nextFollowupAt, start), lt(clients.nextFollowupAt, end))),
    ),
    db.$count(clients, await withVisibility(actor, isNull(clients.lastContactedAt))),
    db.$count(clients, await withVisibility(actor, isNull(clients.nextFollowupAt))),
  ]);

  return (
    <ClientLaunchpad counts={{ all: total, overdue, today, never, none }} />
  );
}
