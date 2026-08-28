import { and, gte, isNotNull, lt } from "drizzle-orm";
import { UsersRoundIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { requireActor, withVisibility } from "@/lib/permissions/server";
import { torontoDayRange } from "@/components/clients/timezone";
import { cn } from "@/lib/utils";

/**
 * Desktop empty state of the master-detail workspace. On mobile the layout's
 * panel IS the page, so this renders nothing below md.
 *
 * Les trois compteurs comptent CE QUE CE REGARD VOIT. Un « 10 412 fiches »
 * affiché à un téléphoniste qui n'en atteint que 300 serait le seul endroit de
 * l'application où le chiffre caché se lit tout haut.
 */
export default async function ClientsPage() {
  const actor = await requireActor();
  const t = await getTranslations("clients");

  const now = new Date();
  const { start, end } = torontoDayRange(now);
  const [total, overdue, today] = await Promise.all([
    db.$count(clients, await withVisibility(actor, undefined)),
    db.$count(
      clients,
      await withVisibility(actor, and(isNotNull(clients.nextFollowupAt), lt(clients.nextFollowupAt, now))),
    ),
    db.$count(
      clients,
      await withVisibility(actor, and(gte(clients.nextFollowupAt, start), lt(clients.nextFollowupAt, end))),
    ),
  ]);

  const stats = [
    { key: "statTotal", value: total, alert: false },
    { key: "statOverdue", value: overdue, alert: overdue > 0 },
    { key: "statToday", value: today, alert: false },
  ] as const;

  return (
    <div className="hidden min-h-[calc(100dvh-2rem)] flex-col items-center justify-center gap-8 px-8 py-16 md:flex">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <UsersRoundIcon className="size-7" />
        </div>
        <div className="space-y-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">{t("empty.title")}</h1>
          <p className="max-w-sm text-sm text-muted-foreground">{t("empty.hint")}</p>
        </div>
      </div>
      <dl className="grid w-full max-w-md grid-cols-3 gap-3">
        {stats.map((s) => (
          <div
            key={s.key}
            className="rounded-xl bg-card px-3 py-4 text-center ring-1 ring-foreground/10"
          >
            <dd
              className={cn(
                "text-2xl font-semibold tabular-nums",
                s.alert && "text-destructive",
              )}
            >
              {s.value}
            </dd>
            <dt className="mt-1 text-xs text-muted-foreground">{t(`empty.${s.key}`)}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}
