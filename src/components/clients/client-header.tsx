"use client";

import {
  ChevronDownIcon,
  EyeOffIcon,
  InboxIcon,
  MailIcon,
  MapPinIcon,
  PhoneIcon,
  PhoneOffIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  assignClientAction,
  setClientCategoryAction,
  type ActionResult,
} from "@/app/(app)/clients/actions";
import { LookIcon, roleLook } from "@/components/look";
import { useTelephony } from "@/components/telephony/telephony-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { emitDataChange } from "@/lib/live";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { BookingLauncher } from "./booking-launcher";

export type HeaderCategory = { id: number; nameFr: string; nameEn: string; color: string };

/**
 * À qui est cette fiche, et ce que ce regard peut y faire.
 *
 * `canClaim` / `canRelease` viennent du MOTEUR (verifyAssignment côté serveur) :
 * les boutons apparaissent exactement quand l'action passerait. Ils ne sont pas
 * la protection — l'action revérifie tout, et répond « verrouillée » ou
 * « plafond atteint » quand la fiche a changé de main entre-temps.
 */
export type ClientOwnership = {
  /** L'identifiant de celui qui regarde — la cible d'une prise. */
  viewerId: string;
  /** Nom du détenteur — null quand la fiche est au bassin. */
  holderName: string | null;
  /** Clé de pastille du RÔLE du détenteur (ROLE_LOOK) — null au bassin. */
  holderLook: string | null;
  canClaim: boolean;
  canRelease: boolean;
  /** Jours sans contact avant expiration du verrou — 0 = jamais. */
  staleDays: number;
  /** Plafond de fiches détenues — 0 = illimité. */
  maxOwned: number;
};

/** Même motif d'initiales que le fil de commentaires. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function ClientHeader({
  client,
  categories,
  ownership,
  contactMasked,
  canCall,
  canBook,
  canChangeCategory,
}: {
  client: {
    id: string;
    fullName: string;
    /** Déjà MASQUÉ par le serveur quand `contactMasked` : jamais le vrai numéro. */
    phone: string;
    email: string | null;
    city: string | null;
    doNotCall: boolean;
    categoryId: number | null;
  };
  categories: HeaderCategory[];
  ownership: ClientOwnership;
  contactMasked: boolean;
  canCall: boolean;
  canBook: boolean;
  canChangeCategory: boolean;
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const router = useRouter();
  const { dial, ready } = useTelephony();
  const [pending, startTransition] = useTransition();

  // Catégorie optimiste : la pastille change AVANT l'aller-retour serveur et
  // revient en arrière (avec un toast) si l'action échoue.
  const [categoryId, setCategoryId] = useState(client.categoryId);
  const inFlightRef = useRef(0);
  useEffect(() => {
    // On ne resynchronise depuis le serveur que hors mutation en vol, sinon un
    // rafraîchissement de fond ferait clignoter l'ancienne valeur.
    if (inFlightRef.current === 0 && !pending) setCategoryId(client.categoryId);
  }, [client.categoryId, pending]);

  const categoryName = (c: HeaderCategory) => (locale === "en" ? c.nameEn : c.nameFr);
  const current = categories.find((c) => c.id === categoryId) ?? null;

  const changeCategory = (nextCategoryId: number | null) => {
    if (nextCategoryId === categoryId) return;
    const previous = categoryId;
    setCategoryId(nextCategoryId);
    inFlightRef.current += 1;
    startTransition(async () => {
      const res = await setClientCategoryAction(client.id, nextCategoryId);
      inFlightRef.current -= 1;
      if (res.ok) {
        toast.success(t("detail.categoryUpdated"));
        // Pastille de couleur du panneau + colonnes du pipeline.
        emitDataChange("clients");
        router.refresh();
      } else {
        setCategoryId(previous);
        toast.error(refusalMessage(res));
      }
    });
  };

  /**
   * Le mot juste d'un refus.
   *
   * « Verrouillée » et « plafond atteint » ne se corrigent pas comme un droit
   * manquant : l'un s'attend (ou se fait débloquer), l'autre demande de rendre
   * une fiche. Et une fiche devenue INVISIBLE répond « introuvable » — c'est
   * ce que le serveur dit, et on ne l'enjolive pas.
   */
  const refusalMessage = (res: Extract<ActionResult, { ok: false }>): string => {
    switch (res.error) {
      case "locked":
        return ownership.staleDays > 0
          ? t("access.locked", { days: ownership.staleDays })
          : t("access.lockedForever");
      case "capReached":
        return t("access.capReached", { max: ownership.maxOwned });
      case "notFound":
        return t("errors.notFound");
      case "forbidden":
        return t("access.noRight");
      default:
        return t("errors.generic");
    }
  };

  /** Prendre la fiche (cible = soi) ou la rendre au bassin (cible = null). */
  const changeHolder = (target: string | null) => {
    startTransition(async () => {
      const res = await assignClientAction(client.id, target);
      if (res.ok) {
        toast.success(target === null ? t("access.released") : t("access.claimed"));
        emitDataChange("clients");
        router.refresh();
      } else {
        toast.error(refusalMessage(res));
      }
    });
  };

  // Un geste qui a besoin du NUMÉRO ne se propose pas quand on ne l'a pas :
  // ce composant n'a reçu qu'un masque, il n'y a rien à composer ni à écrire
  // dans une invitation. Le serveur ferme déjà les deux cases ensemble ; ceci
  // est la ceinture qui va avec les bretelles.
  const canDial = canCall && !contactMasked;
  const canSchedule = canBook && !contactMasked;
  const callDisabled = !ready || client.doNotCall;
  const callButton = (
    <Button
      className="min-h-12 flex-1 bg-emerald-600 px-6 text-base text-white hover:bg-emerald-700 sm:flex-none"
      disabled={callDisabled}
      onClick={() =>
        dial({ number: client.phone, clientId: client.id, clientName: client.fullName })
      }
    >
      <PhoneIcon className="size-5" />
      {t("detail.call")}
    </Button>
  );

  const categoryChipClass =
    "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-medium md:min-h-8";
  const categoryChipStyle = current
    ? {
        color: current.color,
        backgroundColor: `${current.color}1a`,
        borderColor: `${current.color}40`,
      }
    : undefined;
  const categoryChipContent = (
    <>
      {current ? (
        <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: current.color }} />
      ) : null}
      {current ? categoryName(current) : t("detail.noCategory")}
    </>
  );

  return (
    <div className="space-y-3">
      {/* Le retour à la liste vit dans <ClientSwitcher/> au-dessus de l'entête. */}
      {client.doNotCall ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
        >
          <PhoneOffIcon className="size-4 shrink-0" />
          {t("detail.doNotCallBanner")}
        </div>
      ) : null}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {/* Avatar teinté par la catégorie courante (repli : couleur primaire). */}
          <div
            aria-hidden
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-full text-base font-semibold select-none",
              !current && "bg-primary/10 text-primary",
            )}
            style={
              current
                ? { backgroundColor: `${current.color}1a`, color: current.color }
                : undefined
            }
          >
            {initials(client.fullName)}
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-heading text-2xl font-semibold tracking-tight break-words">
                {client.fullName}
              </h1>
              {/* Big category badge with quick-change dropdown — figée en
                  pastille quand le statut n'est pas ouvert à ce regard. */}
              {canChangeCategory ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t("detail.changeCategory")}
                    className={cn(
                      categoryChipClass,
                      "transition outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:brightness-110",
                      !current && "border-border text-muted-foreground hover:bg-muted",
                    )}
                    style={categoryChipStyle}
                  >
                    {categoryChipContent}
                    <ChevronDownIcon className="size-3.5 opacity-70" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-48">
                    {categories.map((c) => (
                      <DropdownMenuItem
                        key={c.id}
                        className="min-h-10"
                        onClick={() => changeCategory(c.id)}
                      >
                        <span
                          aria-hidden
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: c.color }}
                        />
                        {categoryName(c)}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem className="min-h-10" onClick={() => changeCategory(null)}>
                      <span aria-hidden className="size-2.5 rounded-full bg-muted-foreground/40" />
                      {t("detail.noCategory")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span
                  className={cn(
                    categoryChipClass,
                    !current && "border-border text-muted-foreground",
                  )}
                  style={categoryChipStyle}
                >
                  {categoryChipContent}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <PhoneIcon className="size-3.5" />
                {/* Masqué : le serveur n'a envoyé que la forme et les quatre
                    derniers chiffres — il n'y a rien à reformater. */}
                {contactMasked ? client.phone : formatPhone(client.phone)}
              </span>
              {contactMasked ? (
                <span
                  title={t("access.maskedHint")}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                >
                  <EyeOffIcon aria-hidden className="size-3" />
                  {t("access.masked")}
                </span>
              ) : null}
              {client.email ? (
                <a
                  href={`mailto:${client.email}`}
                  className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
                >
                  <MailIcon className="size-3.5" />
                  {client.email}
                </a>
              ) : null}
              {client.city ? (
                <span className="inline-flex items-center gap-1.5">
                  <MapPinIcon className="size-3.5" />
                  {client.city}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canDial ? (
            callDisabled ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger render={<span className="flex-1 sm:flex-none" />}>
                    {callButton}
                  </TooltipTrigger>
                  <TooltipContent>
                    {client.doNotCall ? t("detail.doNotCallTooltip") : t("detail.phoneNotReady")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              callButton
            )
          ) : null}
          {canSchedule ? (
            <BookingLauncher
              client={{
                id: client.id,
                fullName: client.fullName,
                phone: client.phone,
                email: client.email,
              }}
            />
          ) : null}
        </div>
      </div>

      {/* ── À qui est cette fiche ──────────────────────────────────────────────
          La question précède tout le reste de l'écran : ce qu'on peut y faire
          en découle. Une fiche au bassin se prend, une fiche à soi se rend, et
          celle d'un collègue ne bouge pas — le bouton absent le dit déjà. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
        {ownership.holderLook ? (
          <LookIcon look={roleLook(ownership.holderLook)} size="sm" />
        ) : (
          <InboxIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 text-muted-foreground">
          {ownership.holderName
            ? t("access.heldBy", { name: ownership.holderName })
            : t("access.pool")}
        </span>
        <span className="flex-1" />
        {ownership.canClaim ? (
          <Button
            variant="outline"
            className="min-h-11 md:min-h-8"
            disabled={pending}
            onClick={() => changeHolder(ownership.viewerId)}
          >
            {t("access.claim")}
          </Button>
        ) : null}
        {ownership.canRelease ? (
          <Button
            variant="ghost"
            className="min-h-11 md:min-h-8"
            disabled={pending}
            onClick={() => changeHolder(null)}
          >
            {t("access.release")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
