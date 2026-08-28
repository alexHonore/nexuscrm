"use client";

import type { Locale } from "date-fns";
import { formatDistanceToNowStrict } from "date-fns";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  ArrowRightLeftIcon,
  ClockIcon,
  EyeOffIcon,
  MapPinIcon,
  MoreVerticalIcon,
  PhoneIcon,
  PhoneOffIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { useTelephony } from "@/components/telephony/telephony-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import {
  CLIENT_DRAG_MIME,
  columnKey,
  type MoveTargetData,
  type PipelineCardData,
} from "./board";

/** Fuseau d'affichage de l'app (voir AGENTS.md). */
const APP_TZ = "America/Toronto";

const emptySubscribe = () => () => {};

/** true après l'hydratation, false pendant le rendu serveur — sans setState. */
function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

/**
 * Prochain suivi en relatif court (rouge si en retard vs `now`, l'instant du
 * rendu serveur). Sûr à l'hydratation : rend une date absolue stable jusqu'au
 * montage, puis la distance relative.
 */
function FollowupTime({ iso, now, locale }: { iso: string; now: number; locale: Locale }) {
  const mounted = useMounted();
  const date = new Date(iso);
  const overdue = date.getTime() < now;
  return (
    <p
      className={cn(
        "flex items-center gap-1 text-xs",
        overdue ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      <ClockIcon className="size-3 shrink-0" />
      <time dateTime={iso} className="truncate">
        {mounted
          ? formatDistanceToNowStrict(date, { addSuffix: true, locale })
          : formatInTimeZone(date, APP_TZ, "d MMM HH:mm", { locale })}
      </time>
    </p>
  );
}

/**
 * Carte client : clic → fiche, menu kebab (ouvrir / appeler / déplacer),
 * draggable en HTML5 natif pour le desktop.
 */
export function PipelineClientCard({
  card,
  columnId,
  targets,
  now,
  isDragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  card: PipelineCardData;
  columnId: number | null;
  targets: MoveTargetData[];
  /** Instant du rendu serveur (ms epoch) — référence « en retard ». */
  now: number;
  isDragging: boolean;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
  onMove: (cardId: string, toId: number | null) => void;
}) {
  const t = useTranslations("pipeline");
  // Le vocabulaire de l'ACCÈS vit chez les fiches : « Masqué » y est écrit une
  // seule fois, pour la fiche comme pour cette carte.
  const ta = useTranslations("clients");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const { dial, ready } = useTelephony();

  // Ce qu'on peut composer : le numéro reçu, s'il a été envoyé. Une constante
  // plutôt que `card.phone` relu dans le gestionnaire — c'est elle qui garantit
  // qu'on ne compose jamais « rien ».
  const dialNumber = card.phone;

  const dispositionKey = `dispositions.${card.lastDisposition}`;
  const dispositionLabel = card.lastDisposition
    ? t.has(dispositionKey)
      ? t(dispositionKey)
      : card.lastDisposition
    : null;

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CLIENT_DRAG_MIME, card.id);
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(card.id);
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative flex flex-col gap-1 rounded-lg bg-card p-3 shadow-xs ring-1 ring-foreground/10 transition select-none hover:shadow-sm md:cursor-grab md:active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      {/* Toute la carte mène à la fiche ; le kebab passe au-dessus (z-10). */}
      <Link
        href={`/clients/${card.id}`}
        aria-label={card.fullName}
        draggable={false}
        className="absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      />

      <div className="flex items-start justify-between gap-1">
        <p className="flex min-w-0 items-center gap-1.5 pt-1.5 text-sm font-semibold">
          {card.doNotCall ? (
            <PhoneOffIcon
              aria-label={t("card.doNotCall")}
              className="size-3.5 shrink-0 text-destructive"
            />
          ) : null}
          <span className="truncate">{card.fullName}</span>
        </p>

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("card.menu", { name: card.fullName })}
            className="relative z-10 -mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
          >
            <MoreVerticalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem className="min-h-11" onClick={() => router.push(`/clients/${card.id}`)}>
              <UserIcon />
              {t("card.open")}
            </DropdownMenuItem>
            {/* Pas de numéro dans la carte (coordonnées fermées) : pas d'entrée
                « Appeler ». Elle composait une chaîne vide, et sa présence
                laissait croire que le geste était possible. */}
            {dialNumber ? (
              <DropdownMenuItem
                className="min-h-11"
                disabled={!ready || card.doNotCall}
                onClick={() =>
                  dial({ number: dialNumber, clientId: card.id, clientName: card.fullName })
                }
              >
                <PhoneIcon />
                {t("card.call")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="min-h-11">
                <ArrowRightLeftIcon />
                {t("card.moveTo")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                {targets.map((target) => (
                  <DropdownMenuItem
                    key={columnKey(target.id)}
                    className="min-h-11"
                    disabled={target.id === columnId}
                    onClick={() => onMove(card.id, target.id)}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: target.color }}
                    />
                    <span className="truncate">{target.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {card.phone ? (
        <p className="text-xs text-muted-foreground tabular-nums">{formatPhone(card.phone)}</p>
      ) : card.contactHidden ? (
        // Le numéro n'est pas masqué à l'écran : il n'a jamais été envoyé. La
        // pastille dit POURQUOI la ligne est vide — sinon « rien » se lit comme
        // « fiche sans numéro », et quelqu'un part en chercher un.
        <p className="flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
          <EyeOffIcon aria-hidden className="size-3 shrink-0" />
          {ta("access.masked")}
        </p>
      ) : null}

      {card.city ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPinIcon className="size-3 shrink-0" />
          <span className="truncate">{card.city}</span>
        </p>
      ) : null}

      {card.nextFollowupAt ? (
        <FollowupTime iso={card.nextFollowupAt} now={now} locale={dfnsLocale} />
      ) : null}

      {dispositionLabel ? (
        <p className="mt-0.5 w-fit rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {dispositionLabel}
        </p>
      ) : null}
    </article>
  );
}
