"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ATTENTION_LOOK, CONVERSATION_STATE_LOOK, LookIcon, lookTint } from "@/components/look";
import { Badge } from "@/components/ui/badge";
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
  /**
   * Dernier mouvement du fil, DÉJÀ mis en forme par la page.
   *
   * Une chaîne, pas une date + une locale : une locale `date-fns` est un objet
   * de FONCTIONS, et rien de tel ne traverse la frontière serveur → client.
   * Le reste du tableau de bord fait pareil (`dueLabel` des suivis) — c'est la
   * raison pour laquelle ces composants ne reçoivent jamais de locale.
   */
  lastAtLabel: string | null;
};

export function AttentionList({
  rows,
  hidden,
}: {
  rows: AttentionRowData[];
  /** Fils au-delà de ceux affichés — la carte n'en montre qu'une poignée. */
  hidden: number;
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
              {row.lastAtLabel ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {row.lastAtLabel}
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
