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
            className="relative flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 max-md:flex-col max-md:items-stretch max-md:gap-2"
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
                  // Un motif long (« Demande de parler à un humain ») dépassait
                  // sa colonne et glissait SOUS le bouton opaque de droite : le
                  // lecteur voyait une phrase coupée net, sans même les points
                  // de suspension qui l'auraient prévenu. Sous md la pastille
                  // accepte de rétrécir et tronque proprement ; au-delà elle
                  // reste `shrink-0` comme toute pastille, donc intacte.
                  <Badge
                    variant="outline"
                    className="gap-1 font-normal max-md:min-w-0 max-md:shrink"
                    style={lookTint(look)}
                  >
                    {/* Tronquer était la réponse à une colonne de 207 px ; au
                        bureau la pastille a la place de se lire en entier, et
                        l'y couper aurait été un changement de bureau déguisé
                        en correction mobile. */}
                    <span className="max-md:truncate">
                      {tc.has(reasonKey as never) ? tc(reasonKey as never) : reason}
                    </span>
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
            {/* Sur un téléphone ce bouton prenait 126 px des 358 disponibles —
                un tiers de la ligne pour un geste secondaire, au détriment du
                nom et du motif.

                Il a d'abord été réduit à son seul pictogramme, ce que la règle
                11 refuse : « une icône DOUBLE un libellé, elle ne le remplace
                pas », et un `sr-only` ne sauve que le lecteur d'écran — pas
                celui qui regarde une coche carrée en se demandant ce qu'elle
                fait. Le bouton descend donc SOUS la ligne, pleine largeur, où
                il a la place de dire son nom. Au-delà de md, la rangée reprend
                sa disposition d'avant, bouton compris. */}
            <Button
              variant="outline"
              size="sm"
              className="relative z-10 min-h-11 shrink-0 max-md:w-full max-md:justify-center md:min-h-8"
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
          {/* Atteignable veut dire ATTEIGNABLE AU POUCE : en texte de 12 px ce
              lien ne faisait que 16 px de haut. Sous md il devient une bande
              de 44 px sur toute la largeur ; au-delà, `md:inline` lui rend sa
              nature de mot dans une phrase (une boîte en ligne ignore
              `min-height`, le grand écran ne bouge donc pas d'un pixel). */}
          <Link
            href="/conversations"
            className="flex min-h-11 items-center hover:underline md:inline md:min-h-0"
          >
            {t("attention.more", { count: hidden })}
          </Link>
        </li>
      ) : null}
    </ul>
  );
}
