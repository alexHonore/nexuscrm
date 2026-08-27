"use client";

import { formatInTimeZone } from "date-fns-tz";
import type { Locale } from "date-fns";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ATTENTION_LOOK, CONVERSATION_STATE_LOOK, LookIcon, lookTint } from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { APP_TZ } from "@/components/clients/timezone";
import { formatPhone } from "@/lib/phone";

/**
 * Les fils que l'assistant SMS a rendus à un humain, sur le tableau de bord.
 *
 * Extrait de la page pour la même raison que les suivis : la page charge, le
 * composant rend — et c'est le composant qui se teste.
 *
 * Le MOTIF vient du module des conversations (`inbox.reason.*`) : on le LIT
 * chez lui plutôt que d'en recopier vingt ici, où ils dériveraient au premier
 * motif ajouté par le moteur. Un motif inconnu — écrit par un module futur —
 * s'affiche tel quel plutôt que de laisser fuir une clé i18n à l'écran.
 */

export type AttentionRowData = {
  id: string;
  clientId: string | null;
  clientName: string | null;
  clientPhone: string;
  attentionReason: string | null;
  /** Dernier mouvement du fil, ISO. */
  lastAt: string | null;
};

export function AttentionList({
  rows,
  hidden,
  dfnsLocale,
}: {
  rows: AttentionRowData[];
  /** Fils au-delà de ceux affichés — la carte n'en montre qu'une poignée. */
  hidden: number;
  dfnsLocale: Locale;
}) {
  const t = useTranslations("dashboard");
  const tc = useTranslations("conversations");

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const reason = row.attentionReason ?? "";
        const reasonKey = `inbox.reason.${reason}`;
        const look = ATTENTION_LOOK[reason] ?? CONVERSATION_STATE_LOOK.attention;
        return (
          <li key={row.id}>
            <Link
              href={row.clientId ? `/clients/${row.clientId}` : "/conversations"}
              className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
            >
              <LookIcon look={look} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {row.clientName ?? formatPhone(row.clientPhone)}
                </p>
                {reason !== "" ? (
                  <Badge
                    variant="outline"
                    className="mt-0.5 gap-1 font-normal"
                    style={lookTint(look)}
                  >
                    {tc.has(reasonKey as never) ? tc(reasonKey as never) : reason}
                  </Badge>
                ) : null}
              </div>
              {row.lastAt ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatInTimeZone(new Date(row.lastAt), APP_TZ, "d MMM HH:mm", {
                    locale: dfnsLocale,
                  })}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
      {hidden > 0 ? (
        // Ce qui n'est pas montré doit rester ATTEIGNABLE et compté juste —
        // sinon la carte laisse croire que la liste est finie.
        <li className="pt-1 text-xs text-muted-foreground">
          <Link href="/conversations" className="hover:underline">
            {t("attention.more", { count: hidden })}
          </Link>
        </li>
      ) : null}
    </ul>
  );
}
