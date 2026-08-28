"use client";

import { CheckIcon, EyeOffIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { markConversationHandledAction } from "@/app/(app)/conversations/actions";
import { ATTENTION_LOOK, CONVERSATION_STATE_LOOK, LookIcon, lookTint } from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { emitDataChange } from "@/lib/live";
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
  /**
   * Le numéro du fil, ou `null` quand le compartiment de la fiche FERME les
   * coordonnées : la ligne se nomme alors « Masqué » plutôt que de rendre en
   * clair ce que la fiche cache. `null` est un DROIT refusé, pas un fil sans
   * numéro — un fil en a toujours un.
   */
  clientPhone: string | null;
  /**
   * Le numéro manque par DROIT, pas parce que le fil n'en aurait pas. Un
   * booléen à part plutôt qu'un `clientPhone` nul à interpréter : la ligne
   * NOMMÉE (le client a un nom visible) doit elle aussi dire qu'elle masque
   * ses coordonnées, et le nul seul ne le disait qu'aux lignes sans nom.
   */
  contactHidden?: boolean;
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
  // Le vocabulaire de l'accès vit chez les fiches — « Masqué » y est écrit une
  // seule fois, pour la fiche comme pour ce résumé.
  const ta = useTranslations("clients");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /**
   * « C'est réglé » — sans passer par l'écran des conversations.
   *
   * Le MÊME geste et le même mot que dans la boîte de réception
   * (`markConversationHandledAction`, « Marquer traité ») : le fil sort de la
   * liste des deux côtés, et rien ne peut diverger entre les deux écrans.
   */
  const markHandled = (conversationId: string) =>
    startTransition(async () => {
      const result = await markConversationHandledAction(conversationId);
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      toast.success(tc("inbox.handled"));
      // Le même signal que la boîte : les autres vues ouvertes se rafraîchissent.
      emitDataChange("sms");
      router.refresh();
    });

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const reason = row.attentionReason ?? "";
        const reasonKey = `inbox.reason.${reason}`;
        const look = ATTENTION_LOOK[reason] ?? CONVERSATION_STATE_LOOK.attention;
        const title =
          row.clientName ?? (row.clientPhone ? formatPhone(row.clientPhone) : ta("access.masked"));
        // Une ligne dont le titre EST déjà « Masqué » se passe de la pastille :
        // elle dirait deux fois la même chose sur la même ligne.
        const showMasked = row.contactHidden === true && row.clientName !== null;
        return (
          // Le lien couvre la ligne SANS l'envelopper : un bouton dans un lien
          // navigue à chaque clic. Même montage que la boîte de réception —
          // lien en calque, actions au-dessus.
          <li
            key={row.id}
            className="relative flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
          >
            <Link
              href={row.clientId ? `/clients/${row.clientId}` : "/conversations"}
              className="absolute inset-0 rounded-lg"
              aria-label={`${tc("inbox.open")} — ${title}`}
            />
            <LookIcon look={look} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{title}</p>
              {/* Motif et date sur la MÊME ligne, sous le nom : la droite est
                  rendue au geste, qui reste atteignable au pouce sur un
                  téléphone. */}
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                {reason !== "" ? (
                  <Badge variant="outline" className="gap-1 font-normal" style={lookTint(look)}>
                    {tc.has(reasonKey as never) ? tc(reasonKey as never) : reason}
                  </Badge>
                ) : null}
                {showMasked ? (
                  <Badge
                    variant="outline"
                    className="gap-1 font-normal"
                    title={ta("access.maskedHint")}
                  >
                    <EyeOffIcon aria-hidden className="size-3" />
                    {ta("access.masked")}
                  </Badge>
                ) : null}
                {row.lastAtLabel ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {row.lastAtLabel}
                  </span>
                ) : null}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="relative z-10 min-h-11 shrink-0 md:min-h-8"
              disabled={pending}
              onClick={() => markHandled(row.id)}
            >
              <CheckIcon aria-hidden /> {tc("inbox.markHandled")}
            </Button>
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
