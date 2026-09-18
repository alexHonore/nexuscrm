"use client";

import { BotIcon, CheckIcon, PhoneOffIcon, UserRoundIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { completeFollowupAction } from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import { CALL_DIRECTION_LOOK, DASHBOARD_LOOK, LookIcon } from "@/components/look";
import { useTelephony } from "@/components/telephony/telephony-context";
import { cn } from "@/lib/utils";

export type FollowupItemData = {
  id: string;
  clientId: string;
  clientName: string;
  /**
   * Le numéro, ou `null` quand le compartiment de la fiche FERME les
   * coordonnées. `null` est un DROIT refusé, pas une fiche sans numéro : la
   * chaîne vide d'avant ne disait ni l'un ni l'autre, et partait quand même
   * dans le composeur.
   */
  phone: string | null;
  /** Le numéro manque par DROIT — `phoneDisplay` porte alors « Masqué ». */
  contactHidden?: boolean;
  phoneDisplay: string;
  note: string | null;
  dueLabel: string;
  overdue: boolean;
  /** `clients.doNotCall` — gate ABSOLU : le bouton d'appel reste désactivé. */
  doNotCall: boolean;
  /**
   * La case « appeler » de CETTE fiche. Absente : la présence du numéro fait
   * foi — c'est déjà ce que la page envoie, et une ligne sans numéro n'a de
   * toute façon rien à composer.
   */
  canCall?: boolean;
  /** Programmé par l'assistant SMS plutôt que par quelqu'un de l'équipe. */
  aiScheduled: boolean;
  /**
   * Le collègue qui m'a CONFIÉ ce suivi — `null` quand je me le suis noté
   * moi-même (le cas courant) ou quand l'assistant l'a posé.
   */
  assignedByName?: string | null;
};

export function FollowupItem({ item }: { item: FollowupItemData }) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const { dial, ready } = useTelephony();
  const [pending, startTransition] = useTransition();

  // Composer demande le DROIT d'appeler ET un numéro : sans l'un des deux, le
  // bouton DISPARAÎT. Le désactiver aurait laissé croire à une panne, et le
  // laisser vivant composait une chaîne vide.
  const dialNumber = (item.canCall ?? true) ? item.phone : null;

  const markDone = () => {
    startTransition(async () => {
      const res = await completeFollowupAction(item.id);
      if (res.ok) {
        toast.success(t("followups.done"));
        router.refresh();
      } else {
        toast.error(t("error"));
      }
    });
  };

  return (
    <li
      className={cn(
        "rounded-xl border p-3 transition-colors hover:bg-muted/30 sm:p-4",
        item.overdue && "border-l-[3px]",
      )}
      style={item.overdue ? { borderLeftColor: DASHBOARD_LOOK.overdue.color } : undefined}
    >
      <div className="min-w-0 flex-1">
        <Link
          href={`/clients/${item.clientId}`}
          className="flex min-h-6 flex-wrap items-center gap-1.5 text-sm font-semibold hover:underline"
        >
          {item.doNotCall ? (
            <span aria-label={t("followups.doNotCall")} className="inline-flex items-center gap-1 text-xs font-normal" style={{ color: DASHBOARD_LOOK.overdue.color }}>
              <PhoneOffIcon aria-hidden className="size-3.5 shrink-0" />
              {t("followups.doNotCall")}
            </span>
          ) : null}
          <span className="truncate">{item.clientName}</span>
          {/* D'où vient ce rappel. Les deux familles partagent la liste ; sans
              cette marque, « rappeler en septembre » promis par l'assistant se
              lit comme une note qu'on aurait prise soi-même — et on ne sait
              plus lequel des deux a déjà parlé au client. */}
          {item.aiScheduled ? (
            <span aria-label={t("followups.aiScheduled")} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <BotIcon aria-hidden className="size-3 shrink-0" />
              {t("followups.aiScheduled")}
            </span>
          ) : null}
        </Link>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          <span className="font-medium tabular-nums" style={item.overdue ? { color: DASHBOARD_LOOK.overdue.color } : undefined}>
            {item.dueLabel}
          </span>
          {" · "}
          {item.phoneDisplay}
        </p>
        {item.note ? <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.note}</p> : null}
        {/* Sur sa propre ligne : le nom de celui qui a posé la tâche est ce
            qu'on lit quand on se demande « pourquoi je dois rappeler ça ? »,
            et il se ferait couper au bout d'une ligne déjà pleine. */}
        {item.assignedByName ? (
          <p className="mt-1.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
            <UserRoundIcon className="size-3 shrink-0" aria-hidden />
            {t("followups.assignedBy", { name: item.assignedByName })}
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-2">
        {dialNumber ? (
          <Button
            variant="outline"
            className="min-h-11 gap-1.5 px-3 text-xs"
            aria-label={item.doNotCall ? t("followups.doNotCall") : t("followups.call")}
            // Même règle que l'en-tête de la fiche et la carte du pipeline :
            // une fiche « Ne pas appeler » ne se compose pas d'un geste.
            disabled={!ready || item.doNotCall}
            onClick={() =>
              dial({ number: dialNumber, clientId: item.clientId, clientName: item.clientName })
            }
          >
            <LookIcon look={CALL_DIRECTION_LOOK.outbound} className="size-3.5" />
            {t("followups.call")}
          </Button>
        ) : null}
        <Button
          nativeButton={false}
          variant="ghost"
          className="min-h-11 gap-1.5 px-2.5 text-xs text-muted-foreground"
          aria-label={t("followups.open")}
          render={<Link href={`/clients/${item.clientId}`} />}
        >
          <UserRoundIcon aria-hidden className="size-3.5" />
          {t("followups.openShort")}
        </Button>
        <Button
          variant="ghost"
          className="ml-auto min-h-11 gap-1.5 px-2.5 text-xs text-muted-foreground"
          aria-label={t("followups.markDone")}
          disabled={pending}
          onClick={markDone}
        >
          <CheckIcon aria-hidden className="size-3.5" />
          {t("followups.markDone")}
        </Button>
      </div>
    </li>
  );
}
